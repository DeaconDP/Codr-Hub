import { describe, expect, it } from "@effect/vitest";

import { classifyGitStatus, decide, fleetShellBusy, type FleetObservation } from "./fleetDecide.ts";

const current = (overrides: Partial<FleetObservation> = {}): FleetObservation => ({
  git: { _tag: "Current", sha: "aaa" },
  child: { _tag: "Owned", turns: "idle", sha: "aaa" },
  lockInstalled: true,
  fetchedRecently: true,
  ...overrides,
});

describe("decide", () => {
  it("leaves a dirty checkout in place and still starts it when nothing is running", () => {
    const down = decide(
      current({
        git: { _tag: "Dirty" },
        child: { _tag: "Down", port: "free" },
        fetchedRecently: true,
      }),
    );
    expect(down.phase).toBe("stuck");
    expect(down.action).toEqual({ _tag: "Start" });
    expect(down.detail).toContain("uncommitted");

    const running = decide(
      current({
        git: { _tag: "Dirty" },
        fetchedRecently: true,
      }),
    );
    expect(running.action).toEqual({ _tag: "Stay" });
    expect(running.phase).toBe("stuck");
  });

  it("does not fast-forward an ahead or diverged checkout", () => {
    expect(
      decide(current({ git: { _tag: "Ahead", ahead: 2 }, fetchedRecently: true })).action._tag,
    ).toBe("Stay");
    expect(decide(current({ git: { _tag: "Diverged" }, fetchedRecently: true })).phase).toBe(
      "stuck",
    );
  });

  it("waits out a busy turn instead of stopping the server", () => {
    const decision = decide(
      current({
        git: { _tag: "Behind", behind: 1, upstreamSha: "bbb" },
        child: { _tag: "Owned", turns: "busy", sha: "aaa" },
      }),
    );
    expect(decision.action).toEqual({ _tag: "Hold" });
    expect(decision.phase).toBe("waiting");
    expect(decision.detail).toContain("agent turn");
  });

  it("holds a silent heartbeat until the server reports again", () => {
    const decision = decide(
      current({
        git: { _tag: "Behind", behind: 1, upstreamSha: "bbb" },
        child: { _tag: "Owned", turns: "silent", sha: "aaa" },
      }),
    );
    expect(decision.action).toEqual({ _tag: "Hold" });
    expect(decision.detail).toContain("stopped reporting");
  });

  it("stops an idle server that is behind, then fast-forwards once it is down", () => {
    const stop = decide(
      current({
        git: { _tag: "Behind", behind: 3, upstreamSha: "ccc" },
        child: { _tag: "Owned", turns: "idle", sha: "aaa" },
      }),
    );
    expect(stop.action).toEqual({ _tag: "Stop" });
    expect(stop.phase).toBe("updating");

    const forward = decide(
      current({
        git: { _tag: "Behind", behind: 3, upstreamSha: "ccc" },
        child: { _tag: "Down", port: "free" },
      }),
    );
    expect(forward.action).toEqual({ _tag: "FastForward", sha: "ccc" });
  });

  it("installs dependencies only after the server is down", () => {
    const stop = decide(current({ lockInstalled: false }));
    expect(stop.action).toEqual({ _tag: "Stop" });
    const install = decide(
      current({ lockInstalled: false, child: { _tag: "Down", port: "free" } }),
    );
    expect(install.action).toEqual({ _tag: "Install" });
  });

  it("fetches before it moves a clean tree", () => {
    const decision = decide(current({ fetchedRecently: false }));
    expect(decision.action).toEqual({ _tag: "Fetch" });
  });

  it("leaves a foreign listener alone", () => {
    const decision = decide(
      current({
        git: { _tag: "Behind", behind: 1, upstreamSha: "bbb" },
        child: { _tag: "Down", port: "foreign", serverPort: 15_123 },
      }),
    );
    expect(decision.action).toEqual({ _tag: "Stay" });
    expect(decision.phase).toBe("stuck");
    expect(decision.detail).toContain("15123");
  });

  it("stays when the running child already matches the current commit", () => {
    const decision = decide(current());
    expect(decision).toMatchObject({ action: { _tag: "Stay" }, phase: "current" });
  });
});

describe("classifyGitStatus", () => {
  it("treats any porcelain line as local work that must not be fast-forwarded", () => {
    expect(
      classifyGitStatus({
        isRepo: true,
        porcelain: " M apps/server/src/codrHub/CodrHubService.ts\n",
        headSha: "aaa",
        upstreamSha: "bbb",
        ahead: 0,
        behind: 4,
      }),
    ).toEqual({ _tag: "Dirty" });
  });

  it("reports behind only when the worktree matches HEAD", () => {
    expect(
      classifyGitStatus({
        isRepo: true,
        porcelain: "",
        headSha: "aaa",
        upstreamSha: "bbb",
        ahead: 0,
        behind: 2,
      }),
    ).toEqual({ _tag: "Behind", behind: 2, upstreamSha: "bbb" });
  });
});

describe("fleetShellBusy", () => {
  it("counts a live run, an approval, and pending background work", () => {
    expect(fleetShellBusy([{ activityRunStatus: null }])).toBe(false);
    expect(fleetShellBusy([{ activityRunStatus: "running" }])).toBe(true);
    expect(fleetShellBusy([{ activityRunStatus: "waiting" }])).toBe(true);
    expect(fleetShellBusy([{ pendingRuntimeRequest: { id: "1" } }])).toBe(true);
    expect(fleetShellBusy([{ pendingBackgroundTasks: [{}] }])).toBe(true);
  });
});

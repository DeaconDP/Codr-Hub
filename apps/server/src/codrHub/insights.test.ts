import { describe, expect, it } from "@effect/vitest";

import {
  buildDaily,
  bucketCommits,
  detectPlatform,
  groupRunsByRoot,
  isoFromMs,
  makeDayKey,
  providerDriver,
  summarizeAgentRuns,
  untrackedInsights,
  type AgentRunRow,
} from "./insights.ts";

describe("codr-hub insights platform", () => {
  it("lets an engine checkout beat a rough Web tag", () => {
    expect(detectPlatform(["Web"], ["Game.uproject", "Content", "Source"])).toBe("unreal");
    expect(detectPlatform(["web"], ["Assets", "ProjectSettings", "Packages"])).toBe("unity");
  });

  it("trusts an engine tag over the files", () => {
    expect(detectPlatform(["UE5"], ["package.json"])).toBe("unreal");
    expect(detectPlatform(["Android"], ["ios", "android", "package.json"])).toBe("android");
  });

  it("uses a generic tag over generic files", () => {
    expect(detectPlatform(["Desktop"], ["package.json", "index.html"])).toBe("desktop");
  });

  it("reads the checkout when no tag matches", () => {
    expect(detectPlatform(["Client work"], ["ios", "android", "package.json"])).toBe("ios");
    expect(detectPlatform([], ["package.json", "src-tauri"])).toBe("desktop");
    expect(detectPlatform([], ["Cargo.toml", "src"])).toBe("rust");
    expect(detectPlatform([], ["build.gradle.kts", "app"])).toBe("android");
    expect(detectPlatform([], ["pyproject.toml"])).toBe("python");
    expect(detectPlatform([], ["README.md"])).toBe("other");
  });
});

const DAY = 86_400_000;
const now = Date.parse("2026-10-31T12:00:00.000Z");
const ago = (days: number) => now - days * DAY;
const iso = isoFromMs;

describe("codr-hub insights activity", () => {
  it("counts each commit into every window it falls in", () => {
    const seconds = [0.5, 3, 10, 20, 25, 60, 120, 300].map((days) => Math.floor(ago(days) / 1000));
    expect(bucketCommits(seconds, 57, now)).toEqual({
      "24h": 1,
      "7d": 2,
      "14d": 3,
      "21d": 4,
      "1m": 5,
      "3m": 6,
      "6m": 7,
      "1y": 8,
      all: 57,
    });
  });

  it("never reports fewer commits overall than in the last year", () => {
    expect(bucketCommits([Math.floor(ago(1.5) / 1000)], 0, now).all).toBe(1);
  });
});

describe("codr-hub insights agent runs", () => {
  const run = (
    threadId: string,
    provider: string,
    startedDaysAgo: number,
    minutes: number | null,
  ): AgentRunRow => ({
    threadId,
    provider,
    requestedAt: iso(ago(startedDaysAgo)),
    completedAt: minutes === null ? null : iso(ago(startedDaysAgo) + minutes * 60_000),
  });
  const drivers = new Map([["work", "codex"]]);
  const driverOf = (provider: string) => providerDriver(provider, drivers);

  it("maps a run's provider column to its driver", () => {
    expect(providerDriver("codex", drivers)).toBe("codex");
    expect(providerDriver("work", drivers)).toBe("codex");
    expect(providerDriver("claudeAgent_claude_d_worldbuild_io", drivers)).toBe("claudeAgent");
  });

  it("sums runs, distinct threads, capped minutes and drivers per window", () => {
    const agent = summarizeAgentRuns({
      recent: [
        // Still running: counts up to now.
        run("a", "claudeAgent_personal", 0.25, null),
        run("a", "claudeAgent", 2, 30),
        run("b", "work", 10, 15),
        // Stuck for two days: counts as one.
        run("c", "codex", 40, 2 * 24 * 60),
      ],
      history: [
        {
          threadId: "a",
          provider: "codex",
          runs: 3,
          ms: 90 * 60_000,
          lastRequestedAt: iso(ago(400)),
        },
        {
          threadId: "old",
          provider: "cursor",
          runs: 2,
          ms: 60_000,
          lastRequestedAt: iso(ago(500)),
        },
      ],
      nowMs: now,
      driverOf,
    });
    expect(agent.runs).toMatchObject({ "24h": 1, "7d": 2, "14d": 3, "1m": 3, "3m": 4, all: 9 });
    expect(agent.threads).toMatchObject({ "24h": 1, "7d": 1, "14d": 2, "3m": 3, all: 4 });
    expect(agent.minutes).toMatchObject({
      "24h": 360,
      "7d": 390,
      "14d": 405,
      "3m": 405 + 1440,
      all: 405 + 1440 + 91,
    });
    expect(agent.lastRunAt).toBe(iso(ago(0.25)));
    expect(agent.providers.map(({ provider, runs }) => [provider, runs["7d"], runs.all])).toEqual([
      ["codex", 0, 5],
      ["claudeAgent", 2, 2],
      ["cursor", 0, 2],
    ]);
  });

  it("reports the latest older run when nothing ran this year", () => {
    const agent = summarizeAgentRuns({
      recent: [],
      history: [
        { threadId: "x", provider: "codex", runs: 1, ms: 0, lastRequestedAt: iso(ago(500)) },
        { threadId: "y", provider: "codex", runs: 1, ms: 0, lastRequestedAt: iso(ago(400)) },
      ],
      nowMs: now,
      driverOf,
    });
    expect(agent.lastRunAt).toBe(iso(ago(400)));
    expect(agent.runs).toMatchObject({ "1y": 0, all: 2 });
  });
});

describe("codr-hub insights daily", () => {
  it("merges commits and runs into sparse local days within the year, oldest first", () => {
    const utcDay = makeDayKey("UTC");
    const daily = buildDaily({
      commitTimestampsSeconds: [ago(0.1), ago(0.2), ago(3), ago(400)].map((ms) => ms / 1000),
      runs: [
        {
          threadId: "a",
          provider: "codex",
          requestedAt: iso(ago(3)),
          completedAt: iso(ago(3) + 125_000),
        },
        { threadId: "a", provider: "codex", requestedAt: iso(ago(5)), completedAt: null },
      ],
      nowMs: now,
      dayKey: utcDay,
    });
    expect(daily).toEqual([
      // Still running five days later: capped at a day.
      { day: "2026-10-26", commits: 0, runs: 1, minutes: 1440 },
      { day: "2026-10-28", commits: 1, runs: 1, minutes: 2 },
      { day: "2026-10-31", commits: 2, runs: 0, minutes: 0 },
    ]);
  });

  it("keys days by the zone's own offset on either side of a DST change", () => {
    const newYork = makeDayKey("America/New_York");
    // 00:30 EST on the day clocks spring forward, then 00:30 EDT the next day.
    expect(newYork(Date.parse("2026-03-08T05:30:00Z"))).toBe("2026-03-08");
    expect(newYork(Date.parse("2026-03-09T04:30:00Z"))).toBe("2026-03-09");
    expect(newYork(Date.parse("2026-03-09T03:30:00Z"))).toBe("2026-03-08");
  });
});

describe("codr-hub insights workspaces", () => {
  const run = (projectId: string, threadId: string, daysAgo: number) => ({
    projectId,
    threadId,
    provider: "codex",
    requestedAt: iso(ago(daysAgo)),
    completedAt: iso(ago(daysAgo) + 60_000),
  });
  const old = (projectId: string, threadId: string, runs: number) => ({
    projectId,
    threadId,
    provider: "codex",
    runs,
    ms: 0,
    lastRequestedAt: iso(ago(400)),
  });

  it("pools runs on one resolved root across projects and sources", () => {
    const byRoot = groupRunsByRoot([
      {
        workspaces: [
          { projectId: "p1", title: "App", root: "/real/app" },
          { projectId: "p2", title: "App again", root: "/real/app" },
          { projectId: "p3", title: " ", root: "/real/tmp/scratch/" },
        ],
        recent: [run("p1", "a", 1), run("p2", "b", 2), run("p3", "c", 3), run("gone", "d", 1)],
        history: [old("p1", "a", 4)],
      },
      {
        workspaces: [{ projectId: "p1", title: "Other title", root: "/real/app" }],
        recent: [run("p1", "e", 1)],
        history: [],
      },
    ]);
    expect([...byRoot.keys()]).toEqual(["/real/app", "/real/tmp/scratch/"]);
    expect(byRoot.get("/real/app")).toMatchObject({ name: "App" });
    expect(byRoot.get("/real/app")?.recent.map((row) => row.threadId)).toEqual(["a", "b", "e"]);
    expect(byRoot.get("/real/app")?.history).toHaveLength(1);
    expect(byRoot.get("/real/tmp/scratch/")?.name).toBe("scratch");
  });

  it("reports only untracked roots, busiest all-time first, with runs but no commits", () => {
    const byRoot = groupRunsByRoot([
      {
        workspaces: [
          { projectId: "hub", title: "Hub", root: "/hub" },
          { projectId: "quiet", title: "Quiet", root: "/quiet" },
          { projectId: "busy", title: "Busy", root: "/busy" },
        ],
        recent: [run("hub", "h", 1), run("quiet", "q", 2), run("busy", "b", 1)],
        history: [old("busy", "b", 5)],
      },
    ]);
    const untracked = untrackedInsights({
      byRoot,
      trackedRoots: new Set(["/hub"]),
      nowMs: now,
      driverOf: (provider) => provider,
      dayKey: makeDayKey("UTC"),
    });
    expect(untracked.map(({ workspaceRoot, agent }) => [workspaceRoot, agent.runs.all])).toEqual([
      ["/busy", 6],
      ["/quiet", 1],
    ]);
    expect(untracked[1]?.daily).toEqual([{ day: "2026-10-29", commits: 0, runs: 1, minutes: 1 }]);
  });
});

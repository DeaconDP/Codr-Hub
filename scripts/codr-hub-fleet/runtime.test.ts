// @effect-diagnostics nodeBuiltinImport:off - Compare native CLI paths with the server's injected Path service.
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { deriveServerPaths } from "../../apps/server/src/config.ts";
import { decide } from "../../apps/server/src/codrHub/fleetDecide.ts";
import { fleetOptions, observeFleetChild, readChildRecord } from "./runtime.ts";

const nowMs = Date.parse("2026-10-26T10:00:00Z");
const child = { pid: 100, sha: "old", startedAt: nowMs - 10_000 };
const runtime = {
  version: 1,
  pid: 200,
  port: 15_123,
  startedAt: "2026-10-26T09:59:55Z",
};
const activity = { pid: runtime.pid, atMs: nowMs - 1_000, busy: false };

function observe(input: Partial<Parameters<typeof observeFleetChild>[0]> = {}) {
  return observeFleetChild({
    child,
    runtime,
    activity,
    nowMs,
    isAlive: () => true,
    ...input,
  });
}

function updateDecision(input: Partial<Parameters<typeof observeFleetChild>[0]> = {}) {
  return decide({
    git: { _tag: "Behind", behind: 1, upstreamSha: "new" },
    child: observe(input),
    fetchedRecently: true,
    lockInstalled: true,
  });
}

describe("fleet runtime configuration", () => {
  it.effect("uses the same explicit home as server startup, including in a worktree", () =>
    Effect.gen(function* () {
      const repo = NodePath.resolve("/work/checkouts/feature");
      const options = fleetOptions([], repo);
      const server = yield* deriveServerPaths(options.homeDir, new URL("http://localhost:5900"), {
        baseDirIsExplicit: true,
      });
      expect(options.homeDir).toBe(NodePath.join(repo, ".t3"));
      expect(options.stateDir).toBe(server.stateDir);
      expect(options.runtimePath).toBe(server.serverRuntimeStatePath);
      expect(options.hubDir).toBe(NodePath.join(server.stateDir, "codr-hub"));
      expect(options.serverArgs).toEqual(["--home-dir", options.homeDir]);
    }).pipe(Effect.provide(Path.layer)),
  );

  it.effect("carries an explicit home and port into both server and login launches", () =>
    Effect.gen(function* () {
      const options = fleetOptions(
        ["--arm", "--home-dir", "fleet data", "--port", "15123"],
        NodePath.resolve("/work/Codr-Hub"),
      );
      const server = yield* deriveServerPaths(options.homeDir, undefined, {
        baseDirIsExplicit: true,
      });
      expect(options.command).toBe("arm");
      expect(options.stateDir).toBe(server.stateDir);
      expect(options.serverArgs).toEqual([
        "--home-dir",
        NodePath.resolve("/work/Codr-Hub/fleet data"),
        "--port",
        "15123",
      ]);
      expect(options.runArgs).toEqual(["--run", ...options.serverArgs]);
    }).pipe(Effect.provide(Path.layer)),
  );

  it("rejects conflicting commands and invalid options before starting work", () => {
    expect(() => fleetOptions(["--arm", "--run"], "/work")).toThrow("Choose one");
    expect(() => fleetOptions(["--port", "70000"], "/work")).toThrow("--port");
    expect(() => fleetOptions(["--port", "0"], "/work")).toThrow("--port");
    expect(() => fleetOptions(["--port", "1.5"], "/work")).toThrow("--port");
    expect(() => fleetOptions(["--port", "nope"], "/work")).toThrow("--port");
    expect(() => fleetOptions(["--home-dir", " "], "/work")).toThrow("--home-dir");
    expect(readChildRecord({ ...child, pid: -1 })).toBeNull();
    expect(readChildRecord({ ...child, startedAt: Number.NaN })).toBeNull();
  });
});

describe("fleet parent observations", () => {
  it("can update an owned idle server on a shifted dev port", () => {
    expect(updateDecision().action).toEqual({ _tag: "Stop" });
    expect(updateDecision({ activity: { ...activity, busy: true } }).action).toEqual({
      _tag: "Hold",
    });
  });

  it.each([
    null,
    {},
    { ...activity, pid: 999 },
    { ...activity, atMs: nowMs - 60_000 },
    { ...activity, atMs: nowMs + 1 },
    { ...activity, atMs: Number.NaN },
    { ...activity, busy: undefined },
  ])("holds updates without a fresh report from this server (%j)", (report) => {
    expect(updateDecision({ activity: report }).action).toEqual({ _tag: "Hold" });
  });

  it("waits during startup and rejects reports from a previous server", () => {
    expect(updateDecision({ runtime: null }).action).toEqual({ _tag: "Hold" });
    expect(
      updateDecision({
        runtime: { ...runtime, startedAt: "2026-10-26T09:59:49.999Z" },
      }).action,
    ).toEqual({ _tag: "Hold" });
  });

  it("leaves an untracked server and an orphaned server alone, reporting their real port", () => {
    const untracked = updateDecision({ child: null });
    expect(untracked.action).toEqual({ _tag: "Stay" });
    expect(untracked.detail).toContain("15123");
    expect(updateDecision({ isAlive: (pid) => pid === runtime.pid }).action).toEqual({
      _tag: "Stay",
    });
  });

  it("ignores a dead runtime record and lets dev-runner choose the next port", () => {
    expect(observe({ child: null, isAlive: () => false })).toEqual({ _tag: "Down", port: "free" });
    expect(observe({ child: null, runtime: null })).toEqual({ _tag: "Down", port: "free" });
  });
});

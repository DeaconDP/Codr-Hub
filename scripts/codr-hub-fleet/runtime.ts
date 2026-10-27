// @effect-diagnostics nodeBuiltinImport:off - Resolve CLI paths before starting the standalone supervisor.
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type { FleetChild, FleetTurns } from "../../apps/server/src/codrHub/fleetDecide.ts";

const HEARTBEAT_FRESH_MS = 45_000;

export type ChildRecord = {
  readonly pid: number;
  readonly sha: string;
  readonly startedAt: number;
};

export function fleetOptions(args: readonly string[], repoRoot: string) {
  const { values } = NodeUtil.parseArgs({
    args: [...args],
    options: {
      arm: { type: "boolean" },
      disarm: { type: "boolean" },
      run: { type: "boolean" },
      help: { type: "boolean" },
      "home-dir": { type: "string" },
      port: { type: "string" },
    },
  });
  const commands = ["arm", "disarm", "run", "help"] as const;
  const selected = commands.filter((command) => values[command]);
  if (selected.length > 1) throw new Error("Choose one of --arm, --disarm, --run, or --help.");
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error("--port must be an integer from 1 to 65535.");
  }
  if (values["home-dir"] !== undefined && values["home-dir"].trim() === "") {
    throw new Error("--home-dir must name a data directory.");
  }
  // Always explicit, so a login shell cannot redirect this checkout to the live T3 home.
  const homeDir = NodePath.resolve(repoRoot, values["home-dir"] ?? ".t3");
  const stateDir = NodePath.join(homeDir, "userdata");
  const serverArgs = [
    "--home-dir",
    homeDir,
    ...(port === undefined ? [] : ["--port", String(port)]),
  ];
  return {
    command: selected[0] ?? "run",
    homeDir,
    stateDir,
    hubDir: NodePath.join(stateDir, "codr-hub"),
    runtimePath: NodePath.join(stateDir, "server-runtime.json"),
    serverArgs,
    runArgs: ["--run", ...serverArgs],
  };
}

export function readChildRecord(value: unknown): ChildRecord | null {
  if (typeof value !== "object" || value === null) return null;
  if (
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0
  )
    return null;
  if (!("sha" in value) || typeof value.sha !== "string") return null;
  if (
    !("startedAt" in value) ||
    typeof value.startedAt !== "number" ||
    !Number.isFinite(value.startedAt)
  )
    return null;
  return { pid: value.pid, sha: value.sha, startedAt: value.startedAt };
}

function readRuntime(value: unknown) {
  if (typeof value !== "object" || value === null) return null;
  if (!("version" in value) || value.version !== 1) return null;
  if (
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0
  )
    return null;
  if (
    !("port" in value) ||
    typeof value.port !== "number" ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535
  )
    return null;
  if (!("startedAt" in value) || typeof value.startedAt !== "string") return null;
  const startedAt = Date.parse(value.startedAt);
  if (!Number.isFinite(startedAt)) return null;
  return { pid: value.pid, port: value.port, startedAt };
}

function turnsOf(
  activity: unknown,
  serverPid: number,
  startedAt: number,
  nowMs: number,
): FleetTurns {
  if (typeof activity !== "object" || activity === null) return "silent";
  if (!("pid" in activity) || activity.pid !== serverPid) return "silent";
  if (!("atMs" in activity) || typeof activity.atMs !== "number" || !Number.isFinite(activity.atMs))
    return "silent";
  if (
    activity.atMs < startedAt ||
    activity.atMs > nowMs ||
    nowMs - activity.atMs > HEARTBEAT_FRESH_MS
  )
    return "silent";
  if (!("busy" in activity) || typeof activity.busy !== "boolean") return "silent";
  return activity.busy ? "busy" : "idle";
}

export function observeFleetChild(input: {
  readonly child: ChildRecord | null;
  readonly runtime: unknown;
  readonly activity: unknown;
  readonly nowMs: number;
  readonly isAlive: (pid: number) => boolean;
}): FleetChild {
  const runtime = readRuntime(input.runtime);
  const liveRuntime = runtime !== null && input.isAlive(runtime.pid) ? runtime : null;
  if (input.child !== null && input.isAlive(input.child.pid)) {
    return {
      _tag: "Owned",
      sha: input.child.sha,
      turns:
        liveRuntime !== null && liveRuntime.startedAt >= input.child.startedAt
          ? turnsOf(input.activity, liveRuntime.pid, liveRuntime.startedAt, input.nowMs)
          : "silent",
    };
  }
  // Runtime files identify a server, but never grant permission to stop an untracked process.
  return liveRuntime === null
    ? { _tag: "Down", port: "free" }
    : { _tag: "Down", port: "foreign", serverPort: liveRuntime.port };
}

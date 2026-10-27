#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off - Standalone supervisor owns its native process lifecycle outside the server runtime.
/**
 * Login parent for one Codr-Hub checkout.
 * It is the only process that fetches this repo. The server writes turn
 * facts and reads the report. Neither process writes the other's file.
 *
 *   node scripts/codr-hub-fleet/parent.ts --arm
 *   node scripts/codr-hub-fleet/parent.ts --run
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  decide,
  type FleetChild,
  type FleetDecision,
} from "../../apps/server/src/codrHub/fleetDecide.ts";
import { fetchOrigin, fastForward, hashFile, inspectCheckout } from "./git.ts";
import { fleetOptions, observeFleetChild, readChildRecord, type ChildRecord } from "./runtime.ts";
import {
  FLEET_LABEL,
  FLEET_TASK_NAME,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderWindowsTaskCommand,
  type FleetLoginPlan,
} from "../../apps/server/src/codrHub/fleetLogin.ts";

const TICK_MS = 15_000;
const FETCH_FRESH_MS = 60_000;
const RESTART_EXIT = 75;
const platform = HostProcessPlatform.defaultValue();

const scriptPath = NodeURL.fileURLToPath(import.meta.url);
const repoRoot = NodePath.resolve(NodePath.dirname(scriptPath), "../..");
const options = fleetOptions(process.argv.slice(2), repoRoot);
const stateDir = options.hubDir;
const activityPath = NodePath.join(stateDir, "fleet-activity.json");
const reportPath = NodePath.join(stateDir, "fleet.json");
const childPath = NodePath.join(stateDir, "fleet-child.json");
const parentPidPath = NodePath.join(stateDir, "fleet-parent.pid");
const lockReceiptPath = NodePath.join(stateDir, "fleet-lock.txt");
const logPath = NodePath.join(stateDir, "fleet.log");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const readJson = (filePath: string): unknown => {
  try {
    return JSON.parse(NodeFS.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
};

const writeJson = (filePath: string, value: unknown) => {
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    NodeFS.renameSync(temporaryPath, filePath);
  } finally {
    NodeFS.rmSync(temporaryPath, { force: true });
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const readChild = (): ChildRecord | null => readChildRecord(readJson(childPath));

const writeChild = (record: ChildRecord | null) => {
  if (record === null) {
    NodeFS.rmSync(childPath, { force: true });
    return;
  }
  writeJson(childPath, record);
};

const observeChild = (): FleetChild =>
  observeFleetChild({
    child: readChild(),
    runtime: readJson(options.runtimePath),
    activity: readJson(activityPath),
    nowMs: Date.now(),
    isAlive: alive,
  });

const lockInstalled = async (): Promise<boolean> => {
  const hash = await hashFile(repoRoot, "pnpm-lock.yaml");
  if (hash === null) return false;
  try {
    return NodeFS.readFileSync(lockReceiptPath, "utf8").trim() === hash;
  } catch {
    return false;
  }
};

const publish = (decision: FleetDecision, sha: string | null) => {
  writeJson(reportPath, {
    phase: decision.phase,
    detail: decision.detail,
    sha,
    at: new Date().toISOString(),
  });
};

const stopPid = async (pid: number) => {
  const signal = (name: NodeJS.Signals) => {
    if (platform === "win32") {
      NodeChildProcess.spawnSync(
        "taskkill",
        ["/PID", String(pid), "/T", ...(name === "SIGKILL" ? ["/F"] : [])],
        { stdio: "ignore" },
      );
      return;
    }
    try {
      process.kill(-pid, name);
    } catch {
      try {
        process.kill(pid, name);
      } catch {
        // The process is already gone.
      }
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + 8_000;
  while (alive(pid) && Date.now() < deadline) await sleep(200);
  if (alive(pid)) signal("SIGKILL");
  writeChild(null);
};

const vpCommand = () => {
  const besideNode = NodePath.join(NodePath.dirname(process.execPath), "vp");
  const candidates = [
    {
      command: process.execPath,
      args: [NodePath.join(repoRoot, "node_modules", "vite-plus", "bin", "vp")],
    },
    { command: besideNode, args: [] },
    { command: NodePath.join(NodeOS.homedir(), ".local", "bin", "vp"), args: [] },
    { command: NodePath.join(NodeOS.homedir(), ".vite-plus", "bin", "vp"), args: [] },
    { command: "vp", args: [] },
  ];
  for (const candidate of candidates) {
    const probe = NodeChildProcess.spawnSync(candidate.command, [...candidate.args, "--version"], {
      encoding: "utf8",
    });
    if (probe.status === 0) return candidate;
  }
  return null;
};

const startChild = (sha: string) => {
  NodeFS.mkdirSync(stateDir, { recursive: true });
  const log = NodeFS.openSync(logPath, "a");
  const env = { ...process.env };
  const startedAt = Date.now();
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = [
    NodePath.join(repoRoot, "node_modules", ".bin"),
    NodePath.dirname(process.execPath),
    env[pathKey],
  ]
    .filter(Boolean)
    .join(NodePath.delimiter);
  // The current agent may run inside a different T3 server with its own port.
  delete env.T3CODE_PORT;
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["scripts/dev-runner.ts", "dev", ...options.serverArgs],
    {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", log, log],
      env,
    },
  );
  NodeFS.closeSync(log);
  child.unref();
  if (child.pid === undefined) return;
  writeChild({ pid: child.pid, sha, startedAt });
};

const installDependencies = async (): Promise<boolean> => {
  const vp = vpCommand();
  if (vp === null) return false;
  const log = NodeFS.openSync(logPath, "a");
  const code = await new Promise<number>((resolve) => {
    const child = NodeChildProcess.spawn(vp.command, [...vp.args, "i"], {
      cwd: repoRoot,
      stdio: ["ignore", log, log],
    });
    child.on("close", (status) => resolve(status ?? 1));
    child.on("error", () => resolve(1));
  });
  NodeFS.closeSync(log);
  if (code !== 0) return false;
  const hash = await hashFile(repoRoot, "pnpm-lock.yaml");
  if (hash === null) return false;
  NodeFS.writeFileSync(lockReceiptPath, `${hash}\n`);
  return true;
};

const claimParent = () => {
  NodeFS.mkdirSync(stateDir, { recursive: true });
  let existing = Number.NaN;
  try {
    existing = Number(NodeFS.readFileSync(parentPidPath, "utf8").trim());
  } catch {
    existing = Number.NaN;
  }
  if (Number.isInteger(existing) && existing !== process.pid && alive(existing)) {
    console.log("Fleet parent already running.");
    process.exit(0);
  }
  NodeFS.writeFileSync(parentPidPath, `${process.pid}\n`);
};

const plan = (): FleetLoginPlan => ({
  nodePath: process.execPath,
  scriptPath,
  repoRoot,
  logPath,
  runArgs: options.runArgs,
});

const arm = () => {
  const unit = plan();
  NodeFS.mkdirSync(NodePath.dirname(logPath), { recursive: true });
  if (platform === "darwin") {
    const plistPath = NodePath.join(
      NodeOS.homedir(),
      "Library",
      "LaunchAgents",
      `${FLEET_LABEL}.plist`,
    );
    NodeFS.mkdirSync(NodePath.dirname(plistPath), { recursive: true });
    NodeFS.writeFileSync(plistPath, renderLaunchdPlist(unit));
    const domain = `gui/${process.getuid?.() ?? 0}`;
    NodeChildProcess.spawnSync("launchctl", ["bootout", `${domain}/${FLEET_LABEL}`], {
      stdio: "ignore",
    });
    const boot = NodeChildProcess.spawnSync("launchctl", ["bootstrap", domain, plistPath], {
      encoding: "utf8",
    });
    if (boot.status !== 0) {
      console.error(boot.stderr || "launchctl bootstrap failed");
      process.exit(1);
    }
    console.log(`Fleet parent will start at login (${plistPath}).`);
    return;
  }
  if (platform === "linux") {
    const unitPath = NodePath.join(
      NodeOS.homedir(),
      ".config",
      "systemd",
      "user",
      "codrhub-fleet.service",
    );
    NodeFS.mkdirSync(NodePath.dirname(unitPath), { recursive: true });
    NodeFS.writeFileSync(unitPath, renderSystemdUnit(unit));
    NodeChildProcess.spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    const enabled = NodeChildProcess.spawnSync(
      "systemctl",
      ["--user", "enable", "--now", "codrhub-fleet.service"],
      {
        encoding: "utf8",
      },
    );
    if (enabled.status !== 0) {
      console.error(enabled.stderr || "systemctl enable failed");
      process.exit(1);
    }
    console.log(`Fleet parent will start at login (${unitPath}).`);
    return;
  }
  const created = NodeChildProcess.spawnSync(
    "schtasks",
    [
      "/Create",
      "/F",
      "/SC",
      "ONLOGON",
      "/TN",
      FLEET_TASK_NAME,
      "/TR",
      renderWindowsTaskCommand(unit),
    ],
    { encoding: "utf8" },
  );
  if (created.status !== 0) {
    console.error(created.stderr || "schtasks failed");
    process.exit(1);
  }
  console.log("Fleet parent will start at logon.");
};

const disarm = () => {
  if (platform === "darwin") {
    const domain = `gui/${process.getuid?.() ?? 0}`;
    NodeChildProcess.spawnSync("launchctl", ["bootout", `${domain}/${FLEET_LABEL}`], {
      stdio: "ignore",
    });
    NodeFS.rmSync(
      NodePath.join(NodeOS.homedir(), "Library", "LaunchAgents", `${FLEET_LABEL}.plist`),
      { force: true },
    );
    return;
  }
  if (platform === "linux") {
    NodeChildProcess.spawnSync(
      "systemctl",
      ["--user", "disable", "--now", "codrhub-fleet.service"],
      {
        stdio: "ignore",
      },
    );
    NodeFS.rmSync(
      NodePath.join(NodeOS.homedir(), ".config", "systemd", "user", "codrhub-fleet.service"),
      {
        force: true,
      },
    );
    return;
  }
  NodeChildProcess.spawnSync("schtasks", ["/Delete", "/F", "/TN", FLEET_TASK_NAME], {
    stdio: "ignore",
  });
};

const run = async () => {
  claimParent();
  let lastFetchAt = 0;
  for (;;) {
    const inspection = await inspectCheckout(repoRoot);
    const child = observeChild();
    const decision = decide({
      git: inspection.git,
      child,
      lockInstalled: await lockInstalled(),
      fetchedRecently: Date.now() - lastFetchAt < FETCH_FRESH_MS,
    });
    publish(decision, inspection.headSha);
    if (decision.action._tag === "Fetch") {
      await fetchOrigin(repoRoot);
      lastFetchAt = Date.now();
    } else if (decision.action._tag === "Stop" && child._tag === "Owned") {
      const recorded = readChild();
      if (recorded) await stopPid(recorded.pid);
    } else if (decision.action._tag === "FastForward") {
      const moved = await fastForward(repoRoot, decision.action.sha);
      if (moved && process.env.CODR_HUB_FLEET_SUPERVISED === "1") {
        process.exit(RESTART_EXIT);
      }
    } else if (decision.action._tag === "Install") {
      const installed = await installDependencies();
      if (!installed) {
        publish(
          {
            ...decision,
            phase: "stuck",
            detail: "vp i failed. Dependencies were not updated.",
          },
          inspection.headSha,
        );
      }
    } else if (decision.action._tag === "Start") {
      startChild(inspection.headSha ?? "");
    }
    await sleep(TICK_MS);
  }
};

if (options.command === "arm") arm();
else if (options.command === "disarm") disarm();
else if (options.command === "help") {
  console.log(
    "node scripts/codr-hub-fleet/parent.ts [--arm | --disarm | --run] [--home-dir <directory>] [--port <port>]",
  );
  console.log(
    "The data directory defaults to this checkout's .t3. Dev ports are selected by dev-runner.",
  );
} else if (options.command === "run") {
  await run();
}

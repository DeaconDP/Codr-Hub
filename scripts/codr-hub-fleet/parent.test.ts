// @effect-diagnostics nodeBuiltinImport:off - Exercise the standalone CLI in an isolated filesystem with a captured child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";

it("publishes beside the selected server and leaves its untracked process alive", async ({
  onTestFinished,
}) => {
  const sourceRoot = NodePath.resolve(import.meta.dirname, "../..");
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fleet-parent-"));
  let activeParent: NodeChildProcess.ChildProcess | undefined;
  let activeWatcher: NodeFS.FSWatcher | undefined;
  onTestFinished(async () => {
    activeWatcher?.close();
    if (activeParent && activeParent.exitCode === null && activeParent.signalCode === null) {
      const parent = activeParent;
      await new Promise<void>((resolve) => {
        parent.once("exit", () => resolve());
        parent.kill("SIGTERM");
      });
    }
    NodeFS.rmSync(repo, { recursive: true, force: true });
  });
  const files = [
    "scripts/codr-hub-fleet/parent.ts",
    "scripts/codr-hub-fleet/runtime.ts",
    "scripts/codr-hub-fleet/git.ts",
    "apps/server/src/codrHub/fleetDecide.ts",
    "apps/server/src/codrHub/fleetLogin.ts",
  ];
  for (const file of files) {
    const target = NodePath.join(repo, file);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.copyFileSync(NodePath.join(sourceRoot, file), target);
  }
  NodeFS.writeFileSync(NodePath.join(repo, "package.json"), '{"type":"module"}\n');
  NodeFS.symlinkSync(
    NodePath.join(sourceRoot, "scripts", "node_modules"),
    NodePath.join(repo, "scripts", "node_modules"),
    "junction",
  );
  const homeDir = NodePath.join(repo, "fleet data");
  const hubDir = NodePath.join(homeDir, "userdata", "codr-hub");
  NodeFS.mkdirSync(hubDir, { recursive: true });
  const runtimePath = NodePath.join(homeDir, "userdata", "server-runtime.json");
  const runtime = JSON.stringify({
    version: 1,
    pid: process.pid,
    port: 15_123,
    startedAt: "2026-10-26T10:00:00Z",
  });
  NodeFS.writeFileSync(runtimePath, runtime);

  const watcher = NodeFS.watch(hubDir);
  activeWatcher = watcher;
  const parent = NodeChildProcess.spawn(
    process.execPath,
    [
      NodePath.join(repo, "scripts/codr-hub-fleet/parent.ts"),
      "--run",
      "--home-dir",
      homeDir,
      "--port",
      "16123",
    ],
    { cwd: repo, stdio: ["ignore", "ignore", "pipe"] },
  );
  activeParent = parent;
  let stderr = "";
  parent.stderr.on("data", (data) => {
    stderr += String(data);
  });
  const report: unknown = await new Promise((resolve, reject) => {
    parent.on("error", reject);
    parent.on("exit", (code, signal) =>
      reject(new Error(`Fleet parent exited (${code ?? signal}): ${stderr}`)),
    );
    watcher.on("error", reject);
    watcher.on("change", (_event, filename) => {
      if (filename !== "fleet.json") return;
      try {
        resolve(JSON.parse(NodeFS.readFileSync(NodePath.join(hubDir, "fleet.json"), "utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });

  expect(report).toMatchObject({ phase: "stuck", detail: expect.stringContaining("15123") });
  expect(NodeFS.readFileSync(runtimePath, "utf8")).toBe(runtime);
  expect(NodeFS.existsSync(NodePath.join(repo, ".t3"))).toBe(false);
});

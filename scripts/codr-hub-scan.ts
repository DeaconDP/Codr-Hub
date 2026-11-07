#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Bare Node CLI so machines without the server can scan.
// @effect-diagnostics globalConsole:off globalDate:off - Same reason.
/**
 * Writes this machine's workshop scan TSV for Hub → Import scan, with bare Node 24 on macOS,
 * Linux and Windows. Usage: `--help`; docs/user/codr-hub.md#scanning-your-disks.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  isoDay,
  scanDisk,
  scanFileName,
  scanRoots,
  type ScanConfig,
  type ScanRoot,
} from "../apps/server/src/codrHub/diskScan.ts";
import { formatScanTsv } from "../apps/server/src/codrHub/scanTsv.ts";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const hubDir = NodePath.join(repoRoot, ".t3", "userdata", "codr-hub");

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    config: { type: "string" },
    machine: { type: "string" },
    nickname: { type: "string" },
    owner: { type: "string", multiple: true },
    root: { type: "string", multiple: true },
    "no-workshop": { type: "boolean" },
    "no-size": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(
    "Usage: node scripts/codr-hub-scan.ts [--out FILE] [--config scan.json] [--machine NAME]\n" +
      "  [--nickname HUB_MACHINE] [--owner GITHUB_OWNER]... [--root PATH[=Category]]...\n" +
      "  [--no-workshop] [--no-size]",
  );
  process.exit(0);
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const configFile = values.config ?? NodePath.join(hubDir, "scan.json");
const config = (readJson(configFile) ?? {}) as ScanConfig;
const nodeName = (readJson(NodePath.join(hubDir, "node.json")) as { nodeName?: string } | null)
  ?.nodeName;
const hostname = NodeOS.hostname().replace(/\.local$/i, "");

/** The owner of this checkout's `origin`, so the owner's own repos aren't `third-party`. */
const originOwner = () => {
  try {
    const remote = NodeChildProcess.execFileSync(
      "git",
      ["-C", repoRoot, "remote", "get-url", "origin"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return /github\.com[:/]+([^/]+)\//i.exec(remote)?.[1];
  } catch {
    return undefined;
  }
};

const extraRoots: ScanRoot[] = (values.root ?? []).map((spec) => {
  const [path, category] = spec.split(/=(?=[^=]*$)/);
  return { path: NodePath.resolve(path!), category: category ?? "Other" };
});
const owner = originOwner();
const roots = scanRoots({
  ...config,
  ...(values["no-workshop"] ? { workshop: null } : {}),
  roots: [...(config.roots ?? []), ...extraRoots],
});
const today = isoDay(Date.now());

const rows = await scanDisk({
  machine: values.machine ?? config.machine ?? hostname,
  nickname: values.nickname ?? config.nickname ?? nodeName ?? hostname,
  owners: values.owner ?? config.owners ?? (owner === undefined ? [] : [owner]),
  roots,
  today,
  platform: HostProcess.Platform.defaultValue(),
  sizes: !values["no-size"],
});

const out = values.out ?? NodePath.join(hubDir, "scans", scanFileName(hostname, today));
NodeFS.mkdirSync(NodePath.dirname(out), { recursive: true });
NodeFS.writeFileSync(out, formatScanTsv(rows), "utf8");
console.log(`${rows.length} rows from ${roots.length} folders -> ${out}`);

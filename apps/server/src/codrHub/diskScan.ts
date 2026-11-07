// @effect-diagnostics nodeBuiltinImport:off - Plain Node so scripts/codr-hub-scan.ts runs it without the server.
// @effect-diagnostics globalDate:off - Same reason; dates are only formatted as YYYY-MM-DD.
/**
 * Walks a machine's project folders into workshop scan rows: stops at project roots, skips
 * worktrees and build or cache folders. Node built-ins only, so `scripts/codr-hub-scan.ts`
 * runs it on machines without a Hub server.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ScanRow } from "./scanTsv.ts";

const SKIP_NAMES = new Set([
  "node_modules",
  "Library",
  "Temp",
  "Logs",
  "obj",
  "build",
  "DerivedData",
  ".build",
  "Pods",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "dist",
  "Intermediate",
  "Saved",
  "DerivedDataCache",
  "Binaries",
  ".git",
  "$RECYCLE.BIN",
  "System Volume Information",
]);

export interface ScanRoot {
  readonly path: string;
  /** Private / Public / Other / Archive */
  readonly category: string;
  /** Every child is one row; nothing deeper is searched. */
  readonly flat?: boolean;
  /** Added to every row under this root, such as `legacy-path`, `outside-workshop` or `at-risk`. */
  readonly flags?: ReadonlyArray<string>;
}

/** Per-machine scan settings, read from `codr-hub/scan.json` beside `node.json`. */
export interface ScanConfig {
  readonly machine?: string;
  readonly nickname?: string;
  /** GitHub owners whose repositories are not `third-party`. */
  readonly owners?: ReadonlyArray<string>;
  /** The Workshop folder; defaults to `~/Desktop/Workshop` when it exists. */
  readonly workshop?: string | null;
  /** More folders to scan. Outside the Workshop they get `outside-workshop`. */
  readonly roots?: ReadonlyArray<ScanRoot>;
}

/** The Workshop layout every machine shares, with its category per area. */
const WORKSHOP_AREAS: ReadonlyArray<Omit<ScanRoot, "path"> & { readonly area: string }> = [
  { area: "Private", category: "Private" },
  { area: "Public", category: "Public" },
  { area: "Other/Archive", category: "Archive", flat: true },
  { area: "Other/Tools", category: "Other" },
  { area: "Other/Experiments", category: "Other" },
  { area: "Other/Workspaces", category: "Other" },
  { area: "Other/Assets", category: "Other", flat: true },
  { area: "Other/Compatibility", category: "Other", flags: ["legacy-path"] },
];

export function scanRoots(config: ScanConfig, home = NodeOS.homedir()): ReadonlyArray<ScanRoot> {
  const workshop =
    config.workshop === null
      ? null
      : (config.workshop ?? NodePath.join(home, "Desktop", "Workshop"));
  const areas =
    workshop === null
      ? []
      : WORKSHOP_AREAS.map(({ area, ...root }) => ({
          ...root,
          path: NodePath.join(workshop, ...area.split("/")),
        }));
  const inside = (path: string) =>
    workshop !== null &&
    !NodePath.relative(workshop, path).startsWith("..") &&
    !NodePath.isAbsolute(NodePath.relative(workshop, path));
  return [
    ...areas,
    ...(config.roots ?? []).map((root) => ({
      ...root,
      flags: [...(root.flags ?? []), ...(inside(root.path) ? [] : ["outside-workshop"])],
    })),
  ];
}

const listDir = async (path: string) => {
  try {
    return await NodeFSP.readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
};

const MARKERS = ["git", "perforce", "unity", "unreal", "apple", "web", "python"] as const;
type Marker = (typeof MARKERS)[number];

async function markers(path: string): Promise<Set<Marker>> {
  const names = new Set((await listDir(path)).map((entry) => entry.name));
  const found = new Set<Marker>();
  if (names.has(".git")) found.add("git");
  if (names.has("ProjectSettings") && names.has("Assets")) found.add("unity");
  const list = [...names];
  if (list.some((name) => name.endsWith(".uproject"))) found.add("unreal");
  if (
    list.some((name) => name.endsWith(".xcodeproj") || name.endsWith(".xcworkspace")) ||
    names.has("Package.swift")
  ) {
    found.add("apple");
  }
  if (names.has("package.json")) found.add("web");
  if (names.has("pyproject.toml") || names.has("requirements.txt") || names.has("setup.py")) {
    found.add("python");
  }
  if (names.has(".p4config") || names.has("p4config.txt")) found.add("perforce");
  return found;
}

const isRoot = (found: ReadonlySet<Marker>) =>
  found.has("git") ||
  found.has("perforce") ||
  found.has("unity") ||
  found.has("unreal") ||
  found.has("apple");

async function subdirs(path: string): Promise<string[]> {
  return (await listDir(path))
    .filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_NAMES.has(entry.name),
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((name) => NodePath.join(path, name));
}

/** A linked git worktree has a `.git` file pointing into another repo's `worktrees/`. */
async function isWorktree(path: string): Promise<boolean> {
  try {
    const text = await NodeFSP.readFile(NodePath.join(path, ".git"), "utf8");
    return /[\\/]worktrees[\\/]/.test(text);
  } catch {
    return false;
  }
}

async function hasRootBelow(path: string, depth = 3): Promise<boolean> {
  if (depth === 0) return false;
  for (const child of await subdirs(path)) {
    if (isRoot(await markers(child)) || (await hasRootBelow(child, depth - 1))) return true;
  }
  return false;
}

/** Project folders under one root: stops at roots, descends into plain containers. */
async function collectProjects(root: ScanRoot): Promise<string[]> {
  const found: string[] = [];
  const walk = async (path: string, depth: number) => {
    for (const child of await subdirs(path)) {
      if (await isWorktree(child)) continue;
      if ((root.flat === true && depth === 0) || isRoot(await markers(child))) {
        found.push(child);
      } else if (await hasRootBelow(child)) {
        await walk(child, depth + 1);
      } else {
        found.push(child);
      }
    }
  };
  await walk(root.path, 0);
  return found;
}

export type GitRunner = (cwd: string, args: ReadonlyArray<string>) => Promise<string>;

const runGit: GitRunner = (cwd, args) =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout) => resolve(error ? "" : stdout.trim()),
    );
  });

async function laneOf(path: string, found: ReadonlySet<Marker>): Promise<string> {
  if (found.has("unity")) {
    const read = (name: string) =>
      NodeFSP.readFile(NodePath.join(path, "Packages", name), "utf8").catch(() => "");
    const text = (await read("vpm-manifest.json")) + (await read("manifest.json"));
    return text.includes("com.vrchat") ? "VRChat" : "Unity";
  }
  if (found.has("unreal")) return "Unreal";
  if (found.has("apple")) return "Apple";
  if (found.has("web")) return "Web";
  if (found.has("python")) return "Python";
  return /bot/i.test(NodePath.basename(path)) ? "Bot" : "Other";
}

/** Local calendar day, YYYY-MM-DD. */
export const isoDay = (ms: number) => {
  const date = new Date(ms);
  return new Date(ms - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

async function newestMtime(path: string): Promise<string | null> {
  let best = 0;
  for (const entry of await listDir(path)) {
    try {
      best = Math.max(best, (await NodeFSP.lstat(NodePath.join(path, entry.name))).mtimeMs);
    } catch {
      // Unreadable entries don't count.
    }
  }
  return best > 0 ? isoDay(best) : null;
}

/** Folder size in GB: `du` where it exists, otherwise a walk that never follows links. */
async function sizeGb(path: string, platform: NodeJS.Platform): Promise<number | null> {
  if (platform !== "win32") {
    const kb = await new Promise<number | null>((resolve) => {
      NodeChildProcess.execFile("du", ["-sk", path], { timeout: 300_000 }, (_error, stdout) => {
        // du exits non-zero on unreadable files but still prints the total.
        const parsed = Number.parseInt(stdout, 10);
        resolve(Number.isFinite(parsed) ? parsed : null);
      });
    });
    return kb === null ? null : Math.round((kb / 1048576) * 10) / 10;
  }
  let bytes = 0;
  const walk = async (dir: string) => {
    for (const entry of await listDir(dir)) {
      const full = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) bytes += (await NodeFSP.lstat(full).catch(() => null))?.size ?? 0;
    }
  };
  await walk(path);
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

export interface ScanOptions {
  readonly machine: string;
  readonly nickname: string;
  readonly roots: ReadonlyArray<ScanRoot>;
  readonly owners?: ReadonlyArray<string>;
  /** YYYY-MM-DD written in the `scanned` column. */
  readonly today: string;
  readonly platform: NodeJS.Platform;
  readonly sizes?: boolean;
  readonly git?: GitRunner;
  readonly concurrency?: number;
}

async function scanFolder(
  path: string,
  root: ScanRoot,
  options: ScanOptions,
): Promise<Omit<ScanRow, "flags"> & { flags: string[] }> {
  const git = options.git ?? runGit;
  const found = await markers(path);
  const flags = [...(root.flags ?? [])];
  let vcs = "none";
  let remote: string | null = null;
  let branch: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  let dirty: number | null = null;
  let last: string | null = null;
  if (found.has("git")) {
    remote = (await git(path, ["remote", "get-url", "origin"])) || null;
    const owners = (options.owners ?? []).map((owner) => owner.toLowerCase());
    if (remote === null) vcs = "git-local";
    else if (/edgar/i.test(remote)) vcs = "edgar";
    else if (/github\.com/i.test(remote)) {
      vcs = "github";
      const owner = /github\.com[:/]+([^/]+)\//i.exec(remote)?.[1]?.toLowerCase();
      if (owners.length > 0 && (owner === undefined || !owners.includes(owner))) {
        flags.push("third-party");
      }
    } else vcs = "git-local";
    branch = (await git(path, ["rev-parse", "--abbrev-ref", "HEAD"])) || null;
    const counts = (await git(path, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]))
      .split(/\s+/)
      .filter(Boolean);
    if (counts.length === 2) {
      ahead = Number(counts[0]);
      behind = Number(counts[1]);
    }
    const status = await git(path, ["status", "--porcelain"]);
    dirty = status === "" ? 0 : status.split("\n").length;
    last = (await git(path, ["log", "-1", "--format=%cs"])) || null;
  } else if (found.has("perforce")) {
    vcs = "perforce";
  }
  last ??= await newestMtime(path);
  const segments = path.split(/[\\/]/);
  if (segments.some((segment) => /recovered/i.test(segment))) flags.push("copy");
  else if (/(^|[\s_-])copy(\s*\(\d+\))?$|\s-\sCopy/i.test(NodePath.basename(path))) {
    flags.push("copy");
  }
  if (segments.some((segment) => /backup/i.test(segment))) flags.push("backup");
  return {
    machine: options.machine,
    nickname: options.nickname,
    category: root.category,
    lane: await laneOf(path, found),
    name: NodePath.basename(path),
    vcs,
    path,
    remote,
    branch,
    ahead,
    behind,
    dirty,
    lastActivity: last,
    sizeGb: options.sizes === false ? null : await sizeGb(path, options.platform),
    flags: [...new Set(flags)],
    scanned: options.today,
  };
}

const remoteKey = (remote: string) =>
  remote
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");

/** Scans every root and flags every checkout but the best of one remote as `duplicate`. */
export async function scanDisk(options: ScanOptions): Promise<ScanRow[]> {
  const jobs: Array<{ path: string; root: ScanRoot }> = [];
  for (const root of options.roots) {
    try {
      if (!(await NodeFSP.stat(root.path)).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const path of await collectProjects(root)) jobs.push({ path, root });
  }
  const rows: Array<Awaited<ReturnType<typeof scanFolder>>> = Array.from({ length: jobs.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: options.concurrency ?? 8 }, async () => {
      while (next < jobs.length) {
        const index = next++;
        const job = jobs[index]!;
        rows[index] = await scanFolder(job.path, job.root, options);
      }
    }),
  );
  const byRemote = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.remote === null) continue;
    const key = remoteKey(row.remote);
    byRemote.set(key, [...(byRemote.get(key) ?? []), row]);
  }
  for (const group of byRemote.values()) {
    if (group.length < 2) continue;
    group.sort(
      (a, b) =>
        Number(a.category === "Archive") - Number(b.category === "Archive") ||
        Number(a.flags.includes("legacy-path")) - Number(b.flags.includes("legacy-path")) ||
        Number(a.flags.includes("copy")) - Number(b.flags.includes("copy")) ||
        (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""),
    );
    for (const row of group.slice(1)) row.flags.push("duplicate");
  }
  return rows.sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      a.lane.localeCompare(b.lane) ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
}

/** `MACBOOKPRO-2026-11-06.tsv`, matching the existing inventory files. */
export const scanFileName = (machineId: string, today: string) =>
  `${machineId
    .replace(/\.local$/i, "")
    .replace(/[^a-z0-9]+/gi, "")
    .toUpperCase()}-${today}.tsv`;

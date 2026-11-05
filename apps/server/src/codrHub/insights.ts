/**
 * Pure helpers for the Hub dashboard: what a checkout is built with, and how
 * many commits and agent runs landed in each activity window and local day.
 *
 * @module codrHub/insights
 */
import {
  HUB_ACTIVITY_WINDOW_DAYS,
  type HubActivityCounts,
  type HubActivityWindow,
  type HubAgentAttention,
  type HubDailyActivity,
  type HubPlatform,
  type HubUntrackedInsight,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Platforms whose files are unambiguous. These beat a generic tag like "Web". */
const STRONG: ReadonlySet<HubPlatform> = new Set(["unreal", "unity", "ios", "android"]);

const TAG_PLATFORMS: Readonly<Record<string, HubPlatform>> = {
  unreal: "unreal",
  "unreal engine": "unreal",
  ue4: "unreal",
  ue5: "unreal",
  unity: "unity",
  ios: "ios",
  swift: "ios",
  apple: "ios",
  iphone: "ios",
  mobile: "ios",
  expo: "ios",
  "react native": "ios",
  android: "android",
  kotlin: "android",
  web: "web",
  website: "web",
  webapp: "web",
  "web app": "web",
  desktop: "desktop",
  electron: "desktop",
  tauri: "desktop",
  windows: "desktop",
  macos: "desktop",
  python: "python",
  rust: "rust",
};

function platformFromTags(tags: ReadonlyArray<string>) {
  let strong: HubPlatform | null = null;
  let weak: HubPlatform | null = null;
  for (const tag of tags) {
    const platform = TAG_PLATFORMS[tag.trim().toLowerCase()];
    if (platform === undefined) continue;
    if (STRONG.has(platform)) strong ??= platform;
    else weak ??= platform;
  }
  return { strong, weak };
}

function platformFromEntries(entries: ReadonlyArray<string>): HubPlatform | null {
  const names = new Set(entries);
  const any = (test: (name: string) => boolean) => entries.some(test);
  if (any((name) => name.endsWith(".uproject"))) return "unreal";
  if (names.has("ProjectSettings") && names.has("Assets")) return "unity";
  // Expo / React Native lands here too (ios dir, or eas.json before prebuild).
  if (
    any((name) => name.endsWith(".xcodeproj") || name.endsWith(".xcworkspace")) ||
    names.has("Package.swift") ||
    names.has("ios") ||
    names.has("eas.json")
  )
    return "ios";
  if (
    names.has("build.gradle") ||
    names.has("build.gradle.kts") ||
    names.has("settings.gradle") ||
    names.has("settings.gradle.kts") ||
    names.has("android")
  )
    return "android";
  if (
    names.has("src-tauri") ||
    any((name) => name.startsWith("electron-builder")) ||
    any((name) => name.endsWith(".sln") || name.endsWith(".csproj"))
  )
    return "desktop";
  if (names.has("Cargo.toml")) return "rust";
  if (names.has("package.json") || names.has("index.html")) return "web";
  if (names.has("pyproject.toml") || names.has("requirements.txt") || names.has("setup.py"))
    return "python";
  return null;
}

/**
 * Picks a checkout's platform from its tags and root directory entry names.
 * Precedence: an engine/native tag (Unreal, Unity, iOS, Android), then an
 * engine/native file signal, then any other tag, then any other file signal,
 * then "other". Tags are rough imports, so a `.uproject` beats a "Web" tag.
 */
export function detectPlatform(
  tags: ReadonlyArray<string>,
  rootEntries: ReadonlyArray<string>,
): HubPlatform {
  const fromTags = platformFromTags(tags);
  const fromFiles = platformFromEntries(rootEntries);
  if (fromTags.strong !== null) return fromTags.strong;
  if (fromFiles !== null && STRONG.has(fromFiles)) return fromFiles;
  return fromTags.weak ?? fromFiles ?? "other";
}

export const isoFromMs = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** Every bounded window reaches back at most this far; `daily` covers the same span. */
const ACTIVITY_SPAN_DAYS = 365;

/** The oldest time any bounded window or the daily series needs. */
export const activitySinceMs = (nowMs: number) => nowMs - ACTIVITY_SPAN_DAYS * DAY_MS;

const WINDOWS = Object.entries(HUB_ACTIVITY_WINDOW_DAYS) as ReadonlyArray<
  readonly [HubActivityWindow, number | null]
>;

type Counts = Record<HubActivityWindow, number>;

const emptyCounts = (): Counts => ({
  "24h": 0,
  "7d": 0,
  "14d": 0,
  "21d": 0,
  "1m": 0,
  "3m": 0,
  "6m": 0,
  "1y": 0,
  all: 0,
});

/** Adds `amount` to `all` and to every rolling window that `atMs` falls in. */
function addToWindows(counts: Counts, atMs: number, nowMs: number, amount = 1) {
  for (const [window, days] of WINDOWS) {
    if (days === null || atMs >= nowMs - days * DAY_MS) counts[window] += amount;
  }
}

/** `YYYY-MM-DD` of an instant in `timeZone`, or in the node's own zone when omitted. */
export function makeDayKey(timeZone?: string): (ms: number) => string {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (ms) => {
    const parts = Object.fromEntries(
      format.formatToParts(ms).map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
}

/** Parses `git log --format=%ct` output into Unix seconds. */
export function parseCommitTimestamps(stdout: string): number[] {
  return stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
}

/**
 * Counts commits per window. `timestampsSeconds` must cover at least
 * `activitySinceMs(nowMs)`; `totalCount` is all of HEAD's history.
 */
export function bucketCommits(
  timestampsSeconds: ReadonlyArray<number>,
  totalCount: number,
  nowMs: number,
): HubActivityCounts {
  const counts = emptyCounts();
  for (const seconds of timestampsSeconds) addToWindows(counts, seconds * 1000, nowMs);
  return { ...counts, all: Math.max(totalCount, counts["1y"]) };
}

/** One run requested within `activitySinceMs`. Times are ISO strings from the projection. */
export type AgentRunRow = {
  readonly threadId: string;
  readonly provider: string;
  readonly requestedAt: string;
  readonly completedAt: string | null;
};

/** Runs requested before `activitySinceMs`, pre-aggregated per thread and provider. */
export type AgentRunHistoryRow = {
  readonly threadId: string;
  readonly provider: string;
  readonly runs: number;
  readonly ms: number;
  readonly lastRequestedAt: string;
};

/** Longest wall time one run may count for. Keep in step with the history query's cap. */
export const RUN_CAP_MS = DAY_MS;

/** Wall time a run counts for; a run still going counts up to now. */
function runDurationMs(run: AgentRunRow, nowMs: number): number {
  const end = run.completedAt === null ? nowMs : Date.parse(run.completedAt);
  // A stuck run that never reaches a terminal state must not dominate the totals.
  return Math.min(Math.max(end - Date.parse(run.requestedAt), 0), RUN_CAP_MS);
}

/**
 * Maps a run's provider column, which holds a driver (`codex`) or an instance id
 * (`claudeAgent_work`), to the driver kind. Unknown instances (since removed)
 * fall back to the `<driver>_<name>` convention the settings UI suggests.
 */
export function providerDriver(
  provider: string,
  driversByInstance: ReadonlyMap<string, string>,
): string {
  return driversByInstance.get(provider) ?? provider.split("_")[0] ?? provider;
}

const toMinutes = (ms: number) => Math.floor(ms / 60_000);

/** One project's agent attention from its recent runs plus its pre-aggregated history. */
export function summarizeAgentRuns(input: {
  readonly recent: ReadonlyArray<AgentRunRow>;
  readonly history: ReadonlyArray<AgentRunHistoryRow>;
  readonly nowMs: number;
  readonly driverOf: (provider: string) => string;
}): HubAgentAttention {
  const { nowMs } = input;
  const runs = emptyCounts();
  const ms = emptyCounts();
  const threads = new Map<HubActivityWindow, Set<string>>(
    WINDOWS.map(([window]) => [window, new Set()]),
  );
  const providers = new Map<string, Counts>();
  const providerCounts = (provider: string) => {
    const driver = input.driverOf(provider);
    const existing = providers.get(driver);
    if (existing !== undefined) return existing;
    const created = emptyCounts();
    providers.set(driver, created);
    return created;
  };
  let lastRunMs: number | null = null;

  for (const run of input.recent) {
    const at = Date.parse(run.requestedAt);
    addToWindows(runs, at, nowMs);
    addToWindows(ms, at, nowMs, runDurationMs(run, nowMs));
    addToWindows(providerCounts(run.provider), at, nowMs);
    for (const [window, days] of WINDOWS) {
      if (days === null || at >= nowMs - days * DAY_MS) threads.get(window)!.add(run.threadId);
    }
    lastRunMs = Math.max(lastRunMs ?? at, at);
  }
  for (const row of input.history) {
    runs.all += row.runs;
    ms.all += row.ms;
    providerCounts(row.provider).all += row.runs;
    threads.get("all")!.add(row.threadId);
    const at = Date.parse(row.lastRequestedAt);
    lastRunMs = Math.max(lastRunMs ?? at, at);
  }

  const windowsOf = (pick: (window: HubActivityWindow) => number) =>
    Object.fromEntries(WINDOWS.map(([window]) => [window, pick(window)])) as Counts;
  return {
    runs,
    threads: windowsOf((window) => threads.get(window)!.size),
    minutes: windowsOf((window) => toMinutes(ms[window])),
    lastRunAt: lastRunMs === null ? null : isoFromMs(lastRunMs),
    providers: [...providers]
      .map(([provider, counts]) => ({ provider, runs: counts }))
      .sort((a, b) => b.runs.all - a.runs.all),
  };
}

type ProjectRow = { readonly projectId: string };

/** One T3 database's projects and runs. `root` is the workspace root resolved to a real path. */
export type T3WorkspaceRuns = {
  readonly workspaces: ReadonlyArray<{
    readonly projectId: string;
    readonly title: string;
    readonly root: string;
  }>;
  readonly recent: ReadonlyArray<AgentRunRow & ProjectRow>;
  readonly history: ReadonlyArray<AgentRunHistoryRow & ProjectRow>;
};

type RootRuns = {
  readonly name: string;
  readonly recent: AgentRunRow[];
  readonly history: AgentRunHistoryRow[];
};

const basename = (root: string) => root.split(/[\\/]/).findLast((part) => part !== "") ?? root;

/**
 * Pools every source's runs by resolved workspace root, so several T3 projects
 * (in one database or across several) on the same checkout sum together.
 * Runs on a project a source no longer lists are dropped.
 */
export function groupRunsByRoot(sources: ReadonlyArray<T3WorkspaceRuns>): Map<string, RootRuns> {
  const byRoot = new Map<string, RootRuns>();
  for (const source of sources) {
    const workspaces = new Map(
      source.workspaces.map((workspace) => [workspace.projectId, workspace]),
    );
    const entryFor = (projectId: string) => {
      const workspace = workspaces.get(projectId);
      if (workspace === undefined) return undefined;
      const existing = byRoot.get(workspace.root);
      if (existing !== undefined) return existing;
      const created: RootRuns = {
        name: workspace.title.trim() || basename(workspace.root),
        recent: [],
        history: [],
      };
      byRoot.set(workspace.root, created);
      return created;
    };
    for (const row of source.recent) entryFor(row.projectId)?.recent.push(row);
    for (const row of source.history) entryFor(row.projectId)?.history.push(row);
  }
  return byRoot;
}

/** Agent work in workspaces no tracked checkout claims, busiest all-time first. */
export function untrackedInsights(input: {
  readonly byRoot: ReadonlyMap<string, RootRuns>;
  readonly trackedRoots: ReadonlySet<string>;
  readonly nowMs: number;
  readonly driverOf: (provider: string) => string;
  readonly dayKey: (ms: number) => string;
}): HubUntrackedInsight[] {
  const { nowMs, driverOf, dayKey } = input;
  return [...input.byRoot]
    .filter(([root]) => !input.trackedRoots.has(root))
    .map(([workspaceRoot, { name, recent, history }]) => ({
      workspaceRoot,
      name,
      agent: summarizeAgentRuns({ recent, history, nowMs, driverOf }),
      daily: buildDaily({ commitTimestampsSeconds: [], runs: recent, nowMs, dayKey }),
    }))
    .sort((a, b) => b.agent.runs.all - a.agent.runs.all);
}

/**
 * Commits and runs per local day over the last `ACTIVITY_SPAN_DAYS`, sparse and
 * oldest first. Minutes land on the day the run was requested.
 */
export function buildDaily(input: {
  readonly commitTimestampsSeconds: ReadonlyArray<number>;
  readonly runs: ReadonlyArray<AgentRunRow>;
  readonly nowMs: number;
  readonly dayKey: (ms: number) => string;
}): HubDailyActivity[] {
  const since = activitySinceMs(input.nowMs);
  const days = new Map<string, { commits: number; runs: number; ms: number }>();
  const dayAt = (ms: number) => {
    const key = input.dayKey(ms);
    const existing = days.get(key);
    if (existing !== undefined) return existing;
    const created = { commits: 0, runs: 0, ms: 0 };
    days.set(key, created);
    return created;
  };
  for (const seconds of input.commitTimestampsSeconds) {
    if (seconds * 1000 >= since) dayAt(seconds * 1000).commits += 1;
  }
  for (const run of input.runs) {
    const at = Date.parse(run.requestedAt);
    if (at < since) continue;
    const day = dayAt(at);
    day.runs += 1;
    day.ms += runDurationMs(run, input.nowMs);
  }
  return [...days]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, entry]) => ({
      day,
      commits: entry.commits,
      runs: entry.runs,
      minutes: toMinutes(entry.ms),
    }));
}

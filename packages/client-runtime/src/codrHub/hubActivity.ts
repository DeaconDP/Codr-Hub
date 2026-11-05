import type {
  HubActivityCounts,
  HubActivityWindow,
  HubDailyActivity,
  HubInsights,
  HubMergedProjectView,
  HubPriority,
  HubStrategyPriority,
  HubUntrackedInsight,
} from "@t3tools/contracts";
import { compareHubProjects, HUB_ACTIVITY_WINDOW_DAYS } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export const HUB_ACTIVITY_WINDOWS: ReadonlyArray<{ value: HubActivityWindow; label: string }> = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "14d", label: "14d" },
  { value: "21d", label: "21d" },
  { value: "1m", label: "1M" },
  { value: "3m", label: "3M" },
  { value: "6m", label: "6M" },
  { value: "1y", label: "1Y" },
  { value: "all", label: "All" },
];

/** What "attention" is measured in. Runs are agent turns; minutes are agent wall time. */
export type HubAttentionMetric = "runs" | "minutes" | "commits";

export const HUB_ATTENTION_METRICS: ReadonlyArray<{ value: HubAttentionMetric; label: string }> = [
  { value: "runs", label: "Turns" },
  { value: "minutes", label: "Agent time" },
  { value: "commits", label: "Commits" },
];

/** Sparklines never draw more bars than this; longer windows sum days into buckets. */
const SPARK_BUCKETS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type HubAttentionRow = {
  /** The Hub project id, or a synthetic `untracked:` key. */
  readonly projectId: string;
  readonly name: string;
  /** Set for agent work in a folder no Hub project points at. */
  readonly untracked: { readonly nodeName: string; readonly workspaceRoot: string } | null;
  readonly commits: number;
  readonly runs: number;
  readonly threads: number;
  readonly minutes: number;
  /** The selected metric. */
  readonly value: number;
  /** `value` over the window total of the metric, 0..1. */
  readonly share: number;
  /** The metric in the equal period before the window; null when the daily series can't say. */
  readonly previous: number | null;
  readonly lastActiveAt: string | null;
  readonly running: number;
  /** Metric per bucket across the window, oldest first. Empty for 24h. */
  readonly spark: ReadonlyArray<number>;
};

export type HubAttentionNeglected = {
  readonly projectId: string;
  readonly name: string;
  readonly priority: HubPriority;
  readonly onStrategy: boolean;
  readonly lastActiveAt: string | null;
};

export type HubAttentionDay = {
  readonly day: string;
  readonly commits: number;
  readonly runs: number;
  readonly minutes: number;
};

export type HubAttention = {
  /** Projects with the selected metric above zero, highest first. */
  readonly rows: ReadonlyArray<HubAttentionRow>;
  readonly totals: {
    readonly commits: number;
    readonly runs: number;
    readonly threads: number;
    readonly minutes: number;
    /** Projects with any commit or run in the window. */
    readonly activeProjects: number;
  };
  /** Selected metric across all projects in the previous equal period, or null. */
  readonly previousTotal: number | null;
  /** Runs per provider driver in the window, busiest first. */
  readonly providers: ReadonlyArray<{ readonly provider: string; readonly runs: number }>;
  /** Every day of the window, oldest first, zeros included. Empty for 24h; capped at 365 days. */
  readonly series: ReadonlyArray<HubAttentionDay>;
  /** Active projects that are high priority or on the strategy list, with no commits or runs. */
  readonly neglected: ReadonlyArray<HubAttentionNeglected>;
  /** Reported by a machine, with no commits or runs in the window. */
  readonly quietCount: number;
  /** No connected machine has reported this project. */
  readonly unreportedCount: number;
  /** Agents running now, across every machine. */
  readonly runningCount: number;
};

/** `YYYY-MM-DD` in this device's local time zone. */
export function localDayKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Day keys are calendar dates, so their arithmetic runs in UTC where every day is 24h.
const utcMsOfDay = (day: string) => {
  const [year, month, date] = day.split("-").map(Number);
  return Date.UTC(year!, month! - 1, date!);
};

const shiftDay = (day: string, offset: number): string =>
  DateTime.formatIsoDateUtc(DateTime.makeUnsafe(utcMsOfDay(day) + offset * DAY_MS));

const daysBetween = (from: string, to: string): number =>
  Math.round((utcMsOfDay(to) - utcMsOfDay(from)) / DAY_MS);

const latest = (a: string | null, b: string | null) => (a && b ? (a > b ? a : b) : (a ?? b));

type Merged = {
  commits: HubActivityCounts;
  runs: HubActivityCounts;
  threads: HubActivityCounts;
  minutes: HubActivityCounts;
  lastActiveAt: string | null;
  providers: Map<string, HubActivityCounts>;
  daily: Map<string, HubAttentionDay>;
};

const maxCounts = (a: HubActivityCounts, b: HubActivityCounts) =>
  Object.fromEntries(
    Object.keys(a).map((key) => [
      key,
      Math.max(a[key as HubActivityWindow], b[key as HubActivityWindow]),
    ]),
  ) as HubActivityCounts;

const sumCounts = (a: HubActivityCounts, b: HubActivityCounts) =>
  Object.fromEntries(
    Object.keys(a).map((key) => [key, a[key as HubActivityWindow] + b[key as HubActivityWindow]]),
  ) as HubActivityCounts;

/**
 * Checkouts of one project share a git history, so commits take the busiest
 * machine's count. Agent runs are per machine, so they add up.
 */
function mergeInsights(insights: ReadonlyArray<HubInsights>): Map<string, Merged> {
  const merged = new Map<string, Merged>();
  for (const report of insights) {
    for (const insight of report.projects) {
      const current = merged.get(insight.projectId);
      const lastActiveAt = latest(insight.lastCommitAt, insight.agent.lastRunAt);
      if (current === undefined) {
        merged.set(insight.projectId, {
          commits: insight.commits,
          runs: insight.agent.runs,
          threads: insight.agent.threads,
          minutes: insight.agent.minutes,
          lastActiveAt,
          providers: new Map(insight.agent.providers.map((entry) => [entry.provider, entry.runs])),
          daily: new Map(insight.daily.map((day) => [day.day, day])),
        });
        continue;
      }
      current.commits = maxCounts(current.commits, insight.commits);
      current.runs = sumCounts(current.runs, insight.agent.runs);
      current.threads = sumCounts(current.threads, insight.agent.threads);
      current.minutes = sumCounts(current.minutes, insight.agent.minutes);
      current.lastActiveAt = latest(current.lastActiveAt, lastActiveAt);
      for (const entry of insight.agent.providers) {
        const seen = current.providers.get(entry.provider);
        current.providers.set(entry.provider, seen ? sumCounts(seen, entry.runs) : entry.runs);
      }
      for (const day of insight.daily) mergeDay(current.daily, day);
    }
  }
  return merged;
}

const ZERO_COUNTS: HubActivityCounts = {
  "24h": 0,
  "7d": 0,
  "14d": 0,
  "21d": 0,
  "1m": 0,
  "3m": 0,
  "6m": 0,
  "1y": 0,
  all: 0,
};

/** Untracked workspaces are node-local paths, so each stays its own entry. */
const untrackedEntry = (workspace: HubUntrackedInsight): Merged => ({
  commits: ZERO_COUNTS,
  runs: workspace.agent.runs,
  threads: workspace.agent.threads,
  minutes: workspace.agent.minutes,
  lastActiveAt: workspace.agent.lastRunAt,
  providers: new Map(workspace.agent.providers.map((entry) => [entry.provider, entry.runs])),
  daily: new Map(workspace.daily.map((day) => [day.day, day])),
});

function mergeDay(days: Map<string, HubAttentionDay>, day: HubDailyActivity) {
  const seen = days.get(day.day);
  days.set(
    day.day,
    seen
      ? {
          day: day.day,
          commits: Math.max(seen.commits, day.commits),
          runs: seen.runs + day.runs,
          minutes: seen.minutes + day.minutes,
        }
      : day,
  );
}

function sumDays(
  daily: Map<string, HubAttentionDay>,
  metric: HubAttentionMetric,
  from: string,
  to: string,
): number {
  let total = 0;
  for (const [day, entry] of daily) if (day >= from && day <= to) total += entry[metric];
  return total;
}

function sparkOf(
  daily: Map<string, HubAttentionDay>,
  metric: HubAttentionMetric,
  firstDay: string,
  dayCount: number,
): number[] {
  const size = Math.ceil(dayCount / SPARK_BUCKETS);
  const buckets = Array.from({ length: Math.ceil(dayCount / size) }, () => 0);
  for (const [day, entry] of daily) {
    const offset = daysBetween(firstDay, day);
    if (offset < 0 || offset >= dayCount) continue;
    buckets[Math.floor(offset / size)]! += entry[metric];
  }
  return buckets;
}

/**
 * The Hub attention overview: which projects got the most agent turns, agent
 * time, or commits in a window, plus totals, provider mix, a daily series, and
 * important projects that got none. `today` is the device's `localDayKey`.
 */
export function buildHubAttention(input: {
  readonly projects: ReadonlyArray<HubMergedProjectView>;
  readonly insights: ReadonlyArray<HubInsights>;
  readonly strategy: ReadonlyArray<HubStrategyPriority>;
  readonly window: HubActivityWindow;
  readonly metric: HubAttentionMetric;
  readonly today: string;
}): HubAttention {
  const { window, metric, today } = input;
  const merged = mergeInsights(input.insights);

  const allDays = new Map<string, HubAttentionDay>();
  for (const entry of merged.values())
    for (const day of entry.daily.values()) mergeDay(allDays, day);
  for (const report of input.insights)
    for (const workspace of report.untracked)
      for (const day of workspace.daily) mergeDay(allDays, day);
  const earliest = [...allDays.keys()].reduce<string | null>(
    (min, day) => (min === null || day < min ? day : min),
    null,
  );

  const windowDays = HUB_ACTIVITY_WINDOW_DAYS[window];
  // Day-based views: a fixed window, or All from the first recorded day (series cap 365).
  const spanDays =
    windowDays === null
      ? earliest === null
        ? 0
        : Math.min(365, daysBetween(earliest, today) + 1)
      : windowDays === 1
        ? 0
        : windowDays;
  const firstDay = shiftDay(today, -(spanDays - 1));
  // The daily series covers 365 days, so a previous period is only knowable up to 182.
  const comparable = windowDays !== null && windowDays > 1 && windowDays * 2 <= 365;
  const previousRange = comparable
    ? { from: shiftDay(today, -(2 * windowDays - 1)), to: shiftDay(today, -windowDays) }
    : null;

  const rank = compareHubProjects(input.strategy);
  // Fresh arrays from filter and push; Hermes has no toSorted.
  const views = input.projects
    .filter((view) => !view.project.archived)
    .sort((a, b) => rank(a.project, b.project));

  const rows: HubAttentionRow[] = [];
  const neglected: HubAttentionNeglected[] = [];
  const totals = { commits: 0, runs: 0, threads: 0, minutes: 0, activeProjects: 0 };
  const providers = new Map<string, number>();
  let quietCount = 0;
  let unreportedCount = 0;
  let runningCount = 0;
  let previousTotal = 0;

  /** Adds one project's window to the totals, and a row when it has the metric. */
  const count = (
    entry: Merged,
    row: Pick<HubAttentionRow, "projectId" | "name" | "running" | "untracked">,
  ) => {
    const commits = entry.commits[window];
    const runs = entry.runs[window];
    const threads = entry.threads[window];
    const minutes = entry.minutes[window];
    if (commits > 0 || runs > 0) totals.activeProjects += 1;
    totals.commits += commits;
    totals.runs += runs;
    totals.threads += threads;
    totals.minutes += minutes;
    for (const [provider, counts] of entry.providers) {
      if (counts[window] > 0)
        providers.set(provider, (providers.get(provider) ?? 0) + counts[window]);
    }
    const previous = previousRange
      ? sumDays(entry.daily, metric, previousRange.from, previousRange.to)
      : null;
    previousTotal += previous ?? 0;

    const value = { commits, runs, minutes }[metric];
    if (value === 0) return;
    rows.push({
      ...row,
      commits,
      runs,
      threads,
      minutes,
      value,
      share: 0,
      previous,
      lastActiveAt: entry.lastActiveAt,
      spark: spanDays === 0 ? [] : sparkOf(entry.daily, metric, firstDay, spanDays),
    });
  };

  for (const { project, nodes } of views) {
    const running = nodes.reduce((sum, node) => sum + node.running, 0);
    runningCount += running;
    const entry = merged.get(project.id);

    if (entry === undefined) {
      unreportedCount += 1;
      continue;
    }
    const active = entry.commits[window] > 0 || entry.runs[window] > 0;
    if (!active) quietCount += 1;
    // Unreported projects may be busy on a machine that isn't connected, so they never count.
    if (
      !active &&
      project.status === "active" &&
      (project.priority === "critical" ||
        project.priority === "high" ||
        project.strategyId !== null)
    ) {
      neglected.push({
        projectId: project.id,
        name: project.name,
        priority: project.priority,
        onStrategy: project.strategyId !== null,
        lastActiveAt: entry.lastActiveAt,
      });
    }
    count(entry, { projectId: project.id, name: project.name, running, untracked: null });
  }

  for (const report of input.insights) {
    for (const workspace of report.untracked) {
      count(untrackedEntry(workspace), {
        projectId: `untracked:${report.nodeName}:${workspace.workspaceRoot}`,
        name: workspace.name,
        running: 0,
        untracked: { nodeName: report.nodeName, workspaceRoot: workspace.workspaceRoot },
      });
    }
  }

  // Stable sort: equal projects stay in portfolio rank order, Hub projects before untracked.
  rows.sort((a, b) => b.value - a.value);
  const metricTotal = totals[metric];
  const series: HubAttentionDay[] = [];
  for (let offset = 0; offset < spanDays; offset += 1) {
    const day = shiftDay(firstDay, offset);
    series.push(allDays.get(day) ?? { day, commits: 0, runs: 0, minutes: 0 });
  }

  return {
    rows: rows.map((row) => ({ ...row, share: metricTotal === 0 ? 0 : row.value / metricTotal })),
    totals,
    previousTotal: previousRange ? previousTotal : null,
    providers: [...providers]
      .map(([provider, runs]) => ({ provider, runs }))
      .sort((a, b) => b.runs - a.runs),
    series,
    neglected,
    quietCount,
    unreportedCount,
    runningCount,
  };
}

/** Turns when there are any, else commits, so the overview never opens on an empty ranking. */
export function defaultAttentionMetric(totals: HubAttention["totals"]): HubAttentionMetric {
  return totals.runs === 0 && totals.commits > 0 ? "commits" : "runs";
}

/** "3h 20m", "45m", "2d 4h". */
export function formatAgentMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

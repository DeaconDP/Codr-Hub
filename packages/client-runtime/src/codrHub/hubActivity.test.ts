import type {
  HubActivityCounts,
  HubDailyActivity,
  HubInsights,
  HubMergedProjectView,
  HubProject,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildHubAttention, defaultAttentionMetric, formatAgentMinutes } from "./hubActivity.ts";

const TODAY = "2026-11-05";

const view = (
  id: string,
  patch: Partial<HubProject> = {},
  running: ReadonlyArray<number> = [],
): HubMergedProjectView =>
  ({
    project: {
      id,
      name: id,
      priority: "none",
      status: "active",
      stage: "develop",
      strategyId: null,
      favorite: false,
      sortIndex: 0,
      archived: false,
      ...patch,
    },
    handoff: null,
    nodes: running.map((count, index) => ({ nodeName: `node-${index}`, running: count })),
  }) as unknown as HubMergedProjectView;

/** The same count in every window, so tests pick a window without restating all nine. */
const flat = (count: number): HubActivityCounts => ({
  "24h": count,
  "7d": count,
  "14d": count,
  "21d": count,
  "1m": count,
  "3m": count,
  "6m": count,
  "1y": count,
  all: count,
});

type Entry = {
  commits?: number;
  runs?: number;
  threads?: number;
  minutes?: number;
  lastCommitAt?: string;
  lastRunAt?: string;
  providers?: Record<string, number>;
  daily?: ReadonlyArray<HubDailyActivity>;
};

const report = (nodeName: string, entries: Record<string, Entry>): HubInsights =>
  ({
    nodeName,
    computedAt: "2026-11-05T12:00:00.000Z",
    projects: Object.entries(entries).map(([projectId, entry]) => ({
      projectId,
      platform: "web",
      commits: flat(entry.commits ?? 0),
      lastCommitAt: entry.lastCommitAt ?? null,
      agent: {
        runs: flat(entry.runs ?? 0),
        threads: flat(entry.threads ?? 0),
        minutes: flat(entry.minutes ?? 0),
        lastRunAt: entry.lastRunAt ?? null,
        providers: Object.entries(entry.providers ?? {}).map(([provider, runs]) => ({
          provider,
          runs: flat(runs),
        })),
      },
      daily: entry.daily ?? [],
    })),
    untracked: [],
  }) as unknown as HubInsights;

const untracked = (
  insights: HubInsights,
  workspaceRoot: string,
  entry: Pick<Entry, "runs" | "providers" | "daily">,
): HubInsights => ({
  ...insights,
  untracked: [
    ...insights.untracked,
    {
      workspaceRoot,
      name: workspaceRoot.split("/").at(-1)!,
      agent: {
        runs: flat(entry.runs ?? 0),
        threads: flat(1),
        minutes: flat(0),
        lastRunAt: null,
        providers: Object.entries(entry.providers ?? {}).map(([provider, runs]) => ({
          provider,
          runs: flat(runs),
        })),
      },
      daily: entry.daily ?? [],
    },
  ],
});

const day = (date: string, patch: Partial<HubDailyActivity>): HubDailyActivity => ({
  day: date,
  commits: 0,
  runs: 0,
  minutes: 0,
  ...patch,
});

const build = (
  projects: ReadonlyArray<HubMergedProjectView>,
  insights: ReadonlyArray<HubInsights>,
  overrides: Partial<Parameters<typeof buildHubAttention>[0]> = {},
) =>
  buildHubAttention({
    projects,
    insights,
    strategy: [],
    window: "7d",
    metric: "runs",
    today: TODAY,
    ...overrides,
  });

describe("buildHubAttention", () => {
  it("takes the busiest machine's commits but adds up agent work across machines", () => {
    const attention = build(
      [view("shared")],
      [
        report("mac", {
          shared: {
            commits: 9,
            runs: 4,
            threads: 2,
            minutes: 30,
            lastCommitAt: "2026-11-01T00:00:00.000Z",
            providers: { claudeAgent: 4 },
            daily: [day("2026-11-04", { commits: 5, runs: 4, minutes: 30 })],
          },
        }),
        report("pc", {
          shared: {
            commits: 7,
            runs: 3,
            threads: 1,
            minutes: 10,
            lastRunAt: "2026-11-05T09:00:00.000Z",
            providers: { claudeAgent: 1, codex: 2 },
            daily: [day("2026-11-04", { commits: 3, runs: 3, minutes: 10 })],
          },
        }),
      ],
    );
    expect(attention.rows).toHaveLength(1);
    expect(attention.rows[0]).toMatchObject({
      commits: 9,
      runs: 7,
      threads: 3,
      minutes: 40,
      value: 7,
      share: 1,
      lastActiveAt: "2026-11-05T09:00:00.000Z",
    });
    expect(attention.providers).toEqual([
      { provider: "claudeAgent", runs: 5 },
      { provider: "codex", runs: 2 },
    ]);
    expect(attention.series.find((entry) => entry.day === "2026-11-04")).toEqual({
      day: "2026-11-04",
      commits: 5,
      runs: 7,
      minutes: 40,
    });
  });

  it("ranks by the selected metric, keeps portfolio order on ties, and computes shares", () => {
    const projects = [
      view("low", { priority: "low" }, [1]),
      view("high", { priority: "high" }, [1, 2]),
      view("busiest"),
    ];
    const insights = [
      report("mac", {
        low: { runs: 2, commits: 1 },
        high: { runs: 2, commits: 20 },
        busiest: { runs: 4, commits: 0 },
      }),
    ];
    const byRuns = build(projects, insights);
    expect(byRuns.rows.map((row) => [row.projectId, row.share])).toEqual([
      ["busiest", 0.5],
      ["high", 0.25],
      ["low", 0.25],
    ]);
    expect(byRuns.runningCount).toBe(4);

    const byCommits = build(projects, insights, { metric: "commits" });
    // A project with no commits drops out of the commit ranking but still counts as active.
    expect(byCommits.rows.map((row) => row.projectId)).toEqual(["high", "low"]);
    expect(byCommits.totals.activeProjects).toBe(3);
  });

  it("ranks agent work in folders outside the Hub per machine, after Hub projects on ties", () => {
    const mac = untracked(report("mac", { app: { runs: 3 } }), "/work/fleet", {
      runs: 3,
      providers: { codex: 3 },
      daily: [day("2026-11-05", { runs: 3 })],
    });
    const pc = untracked(report("pc", {}), "/work/fleet", { runs: 1 });
    const attention = build([view("app")], [mac, pc]);
    expect(
      attention.rows.map((row) => [row.projectId, row.value, row.untracked?.nodeName ?? null]),
    ).toEqual([
      ["app", 3, null],
      ["untracked:mac:/work/fleet", 3, "mac"],
      ["untracked:pc:/work/fleet", 1, "pc"],
    ]);
    expect(attention.totals).toMatchObject({ runs: 7, activeProjects: 3 });
    expect(attention.providers).toEqual([{ provider: "codex", runs: 3 }]);
    expect(attention.series.at(-1)!.runs).toBe(3);
    expect(attention.unreportedCount).toBe(0);
    expect(defaultAttentionMetric(attention.totals)).toBe("runs");
    expect(defaultAttentionMetric({ ...attention.totals, runs: 0, commits: 2 })).toBe("commits");
  });

  it("flags important active projects with no attention, but never unreported or archived ones", () => {
    const attention = build(
      [
        view("critical-quiet", { priority: "critical" }),
        view("strategy-quiet", { strategyId: "s1" }),
        view("paused-quiet", { priority: "high", status: "paused" }),
        view("low-quiet", { priority: "low" }),
        view("high-unreported", { priority: "high" }),
        view("high-archived", { priority: "high", archived: true }),
        view("high-busy", { priority: "high" }),
      ],
      [
        report("mac", {
          "critical-quiet": { lastCommitAt: "2026-09-01T00:00:00.000Z" },
          "strategy-quiet": {},
          "paused-quiet": {},
          "low-quiet": {},
          "high-archived": {},
          "high-busy": { commits: 1 },
        }),
      ],
    );
    expect(attention.neglected).toEqual([
      {
        projectId: "critical-quiet",
        name: "critical-quiet",
        priority: "critical",
        onStrategy: false,
        lastActiveAt: "2026-09-01T00:00:00.000Z",
      },
      {
        projectId: "strategy-quiet",
        name: "strategy-quiet",
        priority: "none",
        onStrategy: true,
        lastActiveAt: null,
      },
    ]);
    expect(attention.quietCount).toBe(4);
    expect(attention.unreportedCount).toBe(1);
  });

  it("compares the window with the equal period before it from the daily series", () => {
    const insights = [
      report("mac", {
        app: {
          runs: 6,
          daily: [
            // Previous 7 days: Oct 23–29. Window: Oct 30 – Nov 5.
            day("2026-10-22", { runs: 50 }),
            day("2026-10-23", { runs: 2 }),
            day("2026-10-29", { runs: 1 }),
            day("2026-10-30", { runs: 4 }),
            day("2026-11-05", { runs: 2 }),
          ],
        },
      }),
    ];
    const week = build([view("app")], insights);
    expect(week.rows[0]!.previous).toBe(3);
    expect(week.previousTotal).toBe(3);
    expect(week.series).toHaveLength(7);
    expect(week.series[0]!.day).toBe("2026-10-30");
    expect(week.rows[0]!.spark).toEqual([4, 0, 0, 0, 0, 0, 2]);

    // 24h has no day buckets; 1y needs 730 days of history to compare.
    for (const window of ["24h", "1y", "all"] as const) {
      const result = build([view("app")], insights, { window });
      expect(result.previousTotal).toBeNull();
      expect(result.rows[0]!.previous).toBeNull();
    }
    expect(build([view("app")], insights, { window: "24h" }).series).toEqual([]);
  });

  it("buckets long windows into at most 30 spark bars and starts All at the first recorded day", () => {
    const insights = [
      report("mac", {
        app: {
          runs: 3,
          daily: [day("2026-08-07", { runs: 1 }), day("2026-11-05", { runs: 2 })],
        },
      }),
    ];
    const quarter = build([view("app")], insights, { window: "3m" });
    // 91 days in buckets of 4 → 23 bars; Aug 7 is the first day of the window.
    expect(quarter.rows[0]!.spark).toHaveLength(23);
    expect(quarter.rows[0]!.spark[0]).toBe(1);
    expect(quarter.rows[0]!.spark.at(-1)).toBe(2);

    const all = build([view("app")], insights, { window: "all" });
    expect(all.series[0]!.day).toBe("2026-08-07");
    expect(all.series.at(-1)!.day).toBe(TODAY);
  });
});

describe("formatAgentMinutes", () => {
  it.each([
    [0, "0m"],
    [45, "45m"],
    [60, "1h"],
    [200, "3h 20m"],
    [2880, "2d"],
    [3000, "2d 2h"],
  ])("%i → %s", (minutes, label) => {
    expect(formatAgentMinutes(minutes)).toBe(label);
  });
});

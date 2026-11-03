import type { HubInsights, HubMergedProjectView, HubProject } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildHubActivity } from "./hubActivity.ts";

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
      strategyId: null,
      favorite: false,
      sortIndex: 0,
      archived: false,
      ...patch,
    },
    handoff: null,
    nodes: running.map((count, index) => ({ nodeName: `node-${index}`, running: count })),
  }) as unknown as HubMergedProjectView;

const report = (
  nodeName: string,
  counts: Record<string, { week: number; lastCommitAt?: string }>,
): HubInsights =>
  ({
    nodeName,
    computedAt: "2026-11-02T00:00:00.000Z",
    projects: Object.entries(counts).map(([projectId, { week, lastCommitAt }]) => ({
      projectId,
      platform: "web",
      commits: { "24h": 0, "7d": week, "30d": week, ytd: week, all: week },
      lastCommitAt: lastCommitAt ?? null,
    })),
  }) as unknown as HubInsights;

describe("buildHubActivity", () => {
  it("counts a project checked out on two machines once, with its latest commit", () => {
    const activity = buildHubActivity({
      projects: [view("shared"), view("solo")],
      insights: [
        report("mac", { shared: { week: 9, lastCommitAt: "2026-11-01T00:00:00.000Z" } }),
        report("pc", {
          shared: { week: 4, lastCommitAt: "2026-11-02T00:00:00.000Z" },
          solo: { week: 2 },
        }),
      ],
      strategy: [],
      window: "7d",
    });
    expect(activity.rows).toEqual([
      { projectId: "shared", name: "shared", commits: 9, lastCommitAt: "2026-11-02T00:00:00.000Z" },
      { projectId: "solo", name: "solo", commits: 2, lastCommitAt: null },
    ]);
    expect(activity.totalCommits).toBe(11);
  });

  it("separates quiet projects from ones no machine reported, and leaves out archived", () => {
    const activity = buildHubActivity({
      projects: [
        view("busy"),
        view("quiet"),
        view("unscanned"),
        view("old", { archived: true }, [3]),
      ],
      insights: [report("mac", { busy: { week: 1 }, quiet: { week: 0 }, old: { week: 50 } })],
      strategy: [],
      window: "7d",
    });
    expect(activity.rows.map((row) => row.projectId)).toEqual(["busy"]);
    expect(activity.quietCount).toBe(1);
    expect(activity.unreportedCount).toBe(1);
    expect(activity.totalCommits).toBe(1);
    expect(activity.runningCount).toBe(0);
  });

  it("orders equally busy projects by portfolio rank and sums running agents", () => {
    const activity = buildHubActivity({
      projects: [
        view("low", { priority: "low" }, [1]),
        view("high", { priority: "high" }, [1, 2]),
        view("busiest", { priority: "none" }),
      ],
      insights: [report("mac", { low: { week: 3 }, high: { week: 3 }, busiest: { week: 8 } })],
      strategy: [],
      window: "7d",
    });
    expect(activity.rows.map((row) => row.projectId)).toEqual(["busiest", "high", "low"]);
    expect(activity.runningCount).toBe(4);
  });
});

import type {
  HubActivityWindow,
  HubInsights,
  HubMergedProjectView,
  HubStrategyPriority,
} from "@t3tools/contracts";
import { compareHubProjects } from "@t3tools/contracts";

export const HUB_ACTIVITY_WINDOWS: ReadonlyArray<{ value: HubActivityWindow; label: string }> = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "ytd", label: "YTD" },
  { value: "all", label: "All" },
];

export type HubActivityRow = {
  readonly projectId: string;
  readonly name: string;
  readonly commits: number;
  readonly lastCommitAt: string | null;
};

export type HubActivity = {
  /** Projects with commits in the window, busiest first. */
  readonly rows: ReadonlyArray<HubActivityRow>;
  readonly totalCommits: number;
  /** Reported by a machine, with no commits in the window. */
  readonly quietCount: number;
  /** No connected machine has reported this project. */
  readonly unreportedCount: number;
  /** Agents running now, across every machine. */
  readonly runningCount: number;
};

/**
 * One row per project, unlike the dashboard's per-machine tiles. Checkouts of a
 * project share one history, so its commits are the busiest checkout's count
 * rather than a sum that would double count them.
 */
export function buildHubActivity(input: {
  readonly projects: ReadonlyArray<HubMergedProjectView>;
  readonly insights: ReadonlyArray<HubInsights>;
  readonly strategy: ReadonlyArray<HubStrategyPriority>;
  readonly window: HubActivityWindow;
}): HubActivity {
  const reported = new Map<string, { commits: number; lastCommitAt: string | null }>();
  for (const report of input.insights) {
    for (const insight of report.projects) {
      const current = reported.get(insight.projectId);
      const lastCommitAt =
        current?.lastCommitAt && insight.lastCommitAt
          ? current.lastCommitAt > insight.lastCommitAt
            ? current.lastCommitAt
            : insight.lastCommitAt
          : (current?.lastCommitAt ?? insight.lastCommitAt);
      reported.set(insight.projectId, {
        commits: Math.max(current?.commits ?? 0, insight.commits[input.window]),
        lastCommitAt,
      });
    }
  }

  const rank = compareHubProjects(input.strategy);
  // Fresh arrays from filter and push; Hermes has no toSorted.
  const views = input.projects
    .filter((view) => !view.project.archived)
    .sort((a, b) => rank(a.project, b.project));
  const rows: HubActivityRow[] = [];
  let quietCount = 0;
  let unreportedCount = 0;
  let runningCount = 0;
  for (const { project, nodes } of views) {
    for (const node of nodes) runningCount += node.running;
    const activity = reported.get(project.id);
    if (activity === undefined) unreportedCount += 1;
    else if (activity.commits === 0) quietCount += 1;
    else rows.push({ projectId: project.id, name: project.name, ...activity });
  }
  // Stable sort: equally busy projects stay in portfolio rank order.
  rows.sort((a, b) => b.commits - a.commits);
  return {
    rows,
    totalCommits: rows.reduce((sum, row) => sum + row.commits, 0),
    quietCount,
    unreportedCount,
    runningCount,
  };
}

import {
  compareHubProjects,
  type HubActivityCounts,
  type HubActivityWindow,
  type HubGitGlance,
  type HubInsights,
  type HubMergedProjectView,
  type HubPlatform,
  type HubPriority,
  type HubProject,
  type HubProjectInsight,
  type HubProjectStatus,
  type HubSdlcStage,
  type HubStrategyPriority,
} from "@t3tools/contracts";

export type HubDashboardSizeMode = "importance" | "activity";

/** Legend order. It is also the palette slot order, which is what keeps neighbours distinct. */
export const HUB_PLATFORM_ORDER: ReadonlyArray<HubPlatform> = [
  "unreal",
  "unity",
  "ios",
  "android",
  "web",
  "desktop",
  "python",
  "rust",
  "other",
];

/**
 * Fill per platform, stepped separately for light and dark surfaces, plus the
 * label ink with the better contrast on that fill. The eight hues are the
 * dataviz reference categorical palette in its validated order; "other" is a
 * neutral gray so it never reads as a ninth hue.
 */
export const HUB_PLATFORM_COLORS: Record<
  HubPlatform,
  {
    readonly light: string;
    readonly dark: string;
    readonly inkLight: "white" | "ink";
    readonly inkDark: "white" | "ink";
  }
> = {
  unreal: { light: "#2a78d6", dark: "#3987e5", inkLight: "white", inkDark: "ink" },
  unity: { light: "#eb6834", dark: "#d95926", inkLight: "ink", inkDark: "ink" },
  ios: { light: "#1baf7a", dark: "#199e70", inkLight: "ink", inkDark: "ink" },
  android: { light: "#eda100", dark: "#c98500", inkLight: "ink", inkDark: "ink" },
  web: { light: "#e87ba4", dark: "#d55181", inkLight: "ink", inkDark: "ink" },
  desktop: { light: "#008300", dark: "#008300", inkLight: "white", inkDark: "white" },
  python: { light: "#6250d6", dark: "#9085e9", inkLight: "white", inkDark: "ink" },
  rust: { light: "#e34948", dark: "#e66767", inkLight: "ink", inkDark: "ink" },
  other: { light: "#7c7b75", dark: "#6b6a64", inkLight: "ink", inkDark: "white" },
};

export const HUB_ACTIVITY_WINDOWS: ReadonlyArray<{ value: HubActivityWindow; label: string }> = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "ytd", label: "YTD" },
  { value: "all", label: "All" },
];

const PRIORITY_WEIGHT: Record<HubPriority, number> = {
  critical: 8,
  high: 5,
  medium: 3,
  low: 2,
  none: 1,
};

const TAG_PLATFORMS: ReadonlyArray<[HubPlatform, ReadonlyArray<string>]> = [
  ["unreal", ["unreal", "ue4", "ue5", "unreal engine"]],
  ["unity", ["unity"]],
  ["ios", ["ios", "iphone", "ipad", "swift", "swiftui"]],
  ["android", ["android", "kotlin"]],
  ["web", ["web", "website", "webapp", "react", "nextjs", "next.js"]],
  ["desktop", ["desktop", "electron", "tauri", "macos", "windows"]],
  ["python", ["python"]],
  ["rust", ["rust"]],
];

/** Platform from the owner's tags and category when no node has scanned the checkout. */
export function platformFromTags(project: Pick<HubProject, "tags" | "category">): HubPlatform {
  const words = new Set(
    [...project.tags, project.category ?? ""].map((tag) => tag.trim().toLowerCase()),
  );
  for (const [platform, aliases] of TAG_PLATFORMS) {
    if (aliases.some((alias) => words.has(alias))) return platform;
  }
  return "other";
}

/**
 * Priority weight, boosted up to 2x by strategy rank (the top strategy priority
 * doubles, the last adds 1/n) and 1.25x for a favourite.
 */
export function importanceWeight(
  project: Pick<HubProject, "priority" | "strategyId" | "favorite">,
  strategy: ReadonlyArray<Pick<HubStrategyPriority, "id">>,
): number {
  const rank =
    project.strategyId === null
      ? -1
      : strategy.findIndex((priority) => priority.id === project.strategyId);
  const strategyBoost = rank < 0 ? 1 : 1 + (strategy.length - rank) / strategy.length;
  return PRIORITY_WEIGHT[project.priority] * strategyBoost * (project.favorite ? 1.25 : 1);
}

export type HubDashboardTile = {
  /** Unique per machine and project. */
  readonly key: string;
  readonly projectId: string;
  readonly name: string;
  readonly platform: HubPlatform;
  readonly priority: HubPriority;
  readonly stage: HubSdlcStage;
  readonly status: HubProjectStatus;
  readonly favorite: boolean;
  readonly weight: number;
  /** No commits in the window while sizing by activity. */
  readonly dimmed: boolean;
  /** Null when this machine has not reported activity for the checkout. */
  readonly commits: HubActivityCounts | null;
  readonly windowCommits: number | null;
  readonly lastCommitAt: string | null;
  readonly running: number;
  readonly git: HubGitGlance | null;
};

export type HubDashboardMachine = {
  readonly key: string;
  /** Null groups projects with no checkout on any machine. */
  readonly nodeName: string | null;
  readonly tiles: ReadonlyArray<HubDashboardTile>;
  readonly weight: number;
  readonly windowCommits: number;
};

export type HubDashboard = {
  readonly machines: ReadonlyArray<HubDashboardMachine>;
  /** Distinct projects per platform, before the platform filter. */
  readonly platformCounts: Record<HubPlatform, number>;
  readonly projectCount: number;
};

const UNPLACED_KEY = "\u0000unplaced";

/** Machine groups of project tiles for the Hub dashboard treemap. Archived projects are left out. */
export function buildHubDashboard(input: {
  readonly projects: ReadonlyArray<HubMergedProjectView>;
  readonly insights: ReadonlyArray<HubInsights>;
  readonly strategy: ReadonlyArray<HubStrategyPriority>;
  readonly mode: HubDashboardSizeMode;
  readonly window: HubActivityWindow;
  readonly hiddenPlatforms: ReadonlySet<HubPlatform>;
}): HubDashboard {
  const byNode = new Map<string, HubProjectInsight>();
  const byProject = new Map<string, HubProjectInsight>();
  for (const report of input.insights) {
    for (const insight of report.projects) {
      byNode.set(`${report.nodeName}\u0000${insight.projectId}`, insight);
      if (!byProject.has(insight.projectId)) byProject.set(insight.projectId, insight);
    }
  }

  const rank = compareHubProjects(input.strategy);
  const views = input.projects
    .filter((view) => !view.project.archived)
    .toSorted((a, b) => rank(a.project, b.project));

  const platformProjects = new Map<HubPlatform, Set<string>>();
  const groups = new Map<string, { nodeName: string | null; tiles: HubDashboardTile[] }>();
  for (const { project, nodes } of views) {
    const machineNames = new Set([
      ...nodes.filter((node) => node.pathExists).map((node) => node.nodeName),
      ...Object.keys(project.hosts),
    ]);
    const placements = machineNames.size === 0 ? [null] : [...machineNames];
    for (const nodeName of placements) {
      const insight = nodeName === null ? undefined : byNode.get(`${nodeName}\u0000${project.id}`);
      const platform =
        insight?.platform ?? byProject.get(project.id)?.platform ?? platformFromTags(project);
      const seen = platformProjects.get(platform) ?? new Set<string>();
      seen.add(project.id);
      platformProjects.set(platform, seen);
      if (input.hiddenPlatforms.has(platform)) continue;
      const node = nodes.find((entry) => entry.nodeName === nodeName);
      const key = nodeName ?? UNPLACED_KEY;
      const group = groups.get(key) ?? { nodeName, tiles: [] };
      group.tiles.push({
        key: `${key}\u0000${project.id}`,
        projectId: project.id,
        name: project.name,
        platform,
        priority: project.priority,
        stage: project.stage,
        status: project.status,
        favorite: project.favorite,
        weight: input.mode === "importance" ? importanceWeight(project, input.strategy) : 0,
        dimmed: false,
        commits: insight?.commits ?? null,
        windowCommits: insight ? insight.commits[input.window] : null,
        lastCommitAt: insight?.lastCommitAt ?? null,
        running: node?.running ?? 0,
        git: node?.git ?? null,
      });
      groups.set(key, group);
    }
  }

  if (input.mode === "activity") {
    // Quiet checkouts keep a small floor so they stay visible, and sort after active ones.
    let maxCommits = 0;
    for (const group of groups.values()) {
      for (const tile of group.tiles) maxCommits = Math.max(maxCommits, tile.windowCommits ?? 0);
    }
    const floor = maxCommits === 0 ? 1 : Math.max(maxCommits * 0.02, 0.5);
    for (const group of groups.values()) {
      group.tiles = group.tiles
        .map((tile) => {
          const commits = tile.windowCommits ?? 0;
          return { ...tile, weight: Math.max(commits, floor), dimmed: commits === 0 };
        })
        .toSorted((a, b) => Number(a.dimmed) - Number(b.dimmed) || b.weight - a.weight);
    }
  } else {
    for (const group of groups.values()) {
      group.tiles = group.tiles.toSorted((a, b) => b.weight - a.weight);
    }
  }

  const machines = [...groups.entries()]
    .map(([key, group]): HubDashboardMachine => ({
      key,
      nodeName: group.nodeName,
      tiles: group.tiles,
      weight: group.tiles.reduce((sum, tile) => sum + tile.weight, 0),
      windowCommits: group.tiles.reduce((sum, tile) => sum + (tile.windowCommits ?? 0), 0),
    }))
    .toSorted(
      (a, b) =>
        Number(a.nodeName === null) - Number(b.nodeName === null) ||
        b.weight - a.weight ||
        (a.nodeName ?? "").localeCompare(b.nodeName ?? ""),
    );

  const platformCounts = Object.fromEntries(
    HUB_PLATFORM_ORDER.map((platform) => [platform, platformProjects.get(platform)?.size ?? 0]),
  ) as Record<HubPlatform, number>;

  return { machines, platformCounts, projectCount: views.length };
}

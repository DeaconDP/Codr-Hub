import {
  HUB_AUTONOMY_LABELS,
  HUB_STAGE_GROUPS,
  HUB_STAGE_LABELS,
  compareHubProjects,
  mergedProjectLastLaunchAt,
  projectMatchesLane,
  type HubAutonomy,
  type HubImportResult,
  type HubLane,
  type HubMergedProjectView,
  type HubNodeCheckout,
  type HubPaceState,
  type HubPriority,
  type HubProject,
  type HubProjectStatus,
  type HubSdlcMode,
  type HubSdlcStage,
  type HubStrategyPriority,
} from "@t3tools/contracts";

export const PRIORITY_OPTIONS: ReadonlyArray<{ value: HubPriority; label: string }> = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "none", label: "None" },
];

export const STATUS_OPTIONS: ReadonlyArray<{ value: HubProjectStatus; label: string }> = [
  { value: "active", label: "Active" },
  { value: "idea", label: "Idea" },
  { value: "paused", label: "Paused" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
];

export const AUTONOMY_OPTIONS: ReadonlyArray<{ value: HubAutonomy; label: string }> = (
  [0, 25, 50, 75, 100] as const
).map((value) => ({ value, label: HUB_AUTONOMY_LABELS[value] }));

const AUTONOMY_HINT: Record<HubAutonomy, string> = {
  0: "Autopilot skips this project.",
  25: "Proposes a plan. No file changes.",
  50: "Edits in a worktree. You approve each step.",
  75: "Opens a draft pull request. Never merges.",
  100: "Merges when tests pass.",
};

export function autonomyHint(autonomy: HubAutonomy) {
  return AUTONOMY_HINT[autonomy];
}

/**
 * One line under a project name. Off, Active, and the first stage are the
 * defaults, so they stay quiet and the checkout (or a real exception) shows.
 */
export function projectGlance(input: {
  readonly project: HubProject;
  readonly nodes: ReadonlyArray<HubNodeCheckout>;
  readonly selectedNodeName: string;
  readonly strategy: ReadonlyArray<HubStrategyPriority>;
  readonly mode: HubSdlcMode;
}): string {
  const { project, nodes, strategy, mode } = input;
  const selected =
    nodes.find((node) => node.nodeName === input.selectedNodeName) ??
    (nodes.length === 1 ? nodes[0] : undefined);
  const strategyTitle = strategy.find((priority) => priority.id === project.strategyId)?.title;
  const stages = stageOptions(mode);
  const stageValue = stageSelectValue(project.stage, mode);
  const stage = stageValue === stages[0]?.value ? null : labelOf(stages, stageValue);
  const review =
    selected && selected.awaitingReview > 0 ? `${selected.awaitingReview} to review` : null;
  return [
    project.autonomy === 0 ? null : HUB_AUTONOMY_LABELS[project.autonomy],
    project.status === "active" ? null : labelOf(STATUS_OPTIONS, project.status),
    strategyTitle ?? stage,
    hostBit(selected),
    review,
  ]
    .filter((part) => part !== null && part !== undefined)
    .join(" · ");
}

function hostBit(node: HubNodeCheckout | undefined): string | null {
  if (node === undefined || node.localPath === null) return "No checkout";
  if (!node.pathExists) return "Path missing";
  if (node.git === null) return "Not a git repo";
  const branch = node.git.branch ?? "detached";
  return node.git.dirty ? `${branch} · changes` : branch;
}

export const PACE_STATE: Record<HubPaceState, string> = {
  behind: "Behind pace",
  on_pace: "On pace",
  capped: "Capped",
  unavailable: "Unavailable",
};

export const labelOf = <V>(options: ReadonlyArray<{ value: V; label: string }>, value: V) =>
  options.find((option) => option.value === value)?.label ?? String(value);

/** Stage choices for the current SDLC mode; three-stage mode picks each group's first stage. */
export function stageOptions(
  mode: HubSdlcMode,
): ReadonlyArray<{ value: HubSdlcStage; label: string }> {
  if (mode === "six") {
    return (Object.keys(HUB_STAGE_LABELS) as HubSdlcStage[]).map((value) => ({
      value,
      label: HUB_STAGE_LABELS[value],
    }));
  }
  return HUB_STAGE_GROUPS.map((group) => ({ value: group.stages[0], label: group.label }));
}

/** The option a stored stage shows as; in three-stage mode, its group's first stage. */
export function stageSelectValue(stage: HubSdlcStage, mode: HubSdlcMode): HubSdlcStage {
  if (mode === "six") return stage;
  const group = HUB_STAGE_GROUPS.find((entry) =>
    (entry.stages as ReadonlyArray<HubSdlcStage>).includes(stage),
  );
  return group?.stages[0] ?? stage;
}

export type HubProjectFilter = "open" | "all" | HubProjectStatus | "archived";

export type HubProjectSort = "rank" | "name" | "recent";

/** "Open" hides done and archived work, which is what the owner scans day to day. */
export function filterAndSortProjects(
  views: ReadonlyArray<HubMergedProjectView>,
  options: {
    readonly filter: HubProjectFilter;
    readonly query: string;
    readonly sort: HubProjectSort;
    readonly strategy: ReadonlyArray<HubStrategyPriority>;
    readonly lane?: HubLane | null;
  },
): HubMergedProjectView[] {
  const query = options.query.trim().toLowerCase();
  const lane = options.lane ?? null;
  const matchesFilter = (view: HubMergedProjectView) => {
    const { project } = view;
    switch (options.filter) {
      case "all":
        return true;
      case "archived":
        return project.archived;
      case "open":
        return !project.archived && project.status !== "done";
      default:
        return !project.archived && project.status === options.filter;
    }
  };
  const matchesQuery = (view: HubMergedProjectView) =>
    query === "" ||
    [
      view.project.name,
      view.project.category ?? "",
      ...view.project.tags,
      ...view.nodes.flatMap((node) => [node.nodeName, node.localPath ?? ""]),
    ].some((text) => text.toLowerCase().includes(query));
  const rank = compareHubProjects(options.strategy);
  const compare = (a: HubMergedProjectView, b: HubMergedProjectView) => {
    if (options.sort === "name") return a.project.name.localeCompare(b.project.name);
    if (options.sort === "recent") {
      const aAt = mergedProjectLastLaunchAt(a) ?? a.project.updatedAt;
      const bAt = mergedProjectLastLaunchAt(b) ?? b.project.updatedAt;
      return bAt.localeCompare(aAt);
    }
    return rank(a.project, b.project);
  };
  return views
    .filter(
      (view) => matchesFilter(view) && matchesQuery(view) && projectMatchesLane(view.project, lane),
    )
    .toSorted(compare);
}

/** A short, file-safe id with a random suffix so two nodes adding the same title never collide. */
export function newStrategyId(title: string, random: string) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "priority"}-${random.slice(0, 6)}`;
}

/** One line for a T3 import or sync result; zero counts are left out. */
export function t3SyncSummary(result: HubImportResult): string {
  const parts = [
    result.imported > 0 ? `added ${result.imported}` : null,
    result.updated > 0 ? `linked ${result.updated}` : null,
    (result.created ?? 0) > 0 ? `added ${result.created} to T3` : null,
  ].filter((part) => part !== null);
  if (parts.length === 0) return "Already in step with T3.";
  const text = parts.join(", ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

import {
  HUB_STAGE_GROUPS,
  HUB_STAGE_LABELS,
  compareHubProjects,
  mergedProjectLastLaunchAt,
  type HubMergedProjectView,
  type HubPaceState,
  type HubPriority,
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

export const AUTONOMY_OPTIONS = [
  { value: 0, label: "Off" },
  { value: 25, label: "25% · Plan" },
  { value: 50, label: "50% · Supervised" },
  { value: 75, label: "75% · Draft PR" },
  { value: 100, label: "100% · Full auto" },
] as const;

export const PACE_STATE: Record<
  HubPaceState,
  { label: string; variant: "warning" | "success" | "info" | "outline" }
> = {
  behind: { label: "Behind pace", variant: "warning" },
  on_pace: { label: "On pace", variant: "success" },
  capped: { label: "Capped", variant: "info" },
  unavailable: { label: "Unavailable", variant: "outline" },
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

export const FILTER_OPTIONS: ReadonlyArray<{ value: HubProjectFilter; label: string }> = [
  { value: "open", label: "Open" },
  { value: "all", label: "All" },
  ...STATUS_OPTIONS,
  { value: "archived", label: "Archived" },
];

export type HubProjectSort = "rank" | "name" | "recent";

/** "Open" hides done and archived work, which is what the owner scans day to day. */
export function filterAndSortProjects(
  views: ReadonlyArray<HubMergedProjectView>,
  options: {
    readonly filter: HubProjectFilter;
    readonly query: string;
    readonly sort: HubProjectSort;
    readonly strategy: ReadonlyArray<HubStrategyPriority>;
  },
): HubMergedProjectView[] {
  const query = options.query.trim().toLowerCase();
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
  return views.filter((view) => matchesFilter(view) && matchesQuery(view)).toSorted(compare);
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

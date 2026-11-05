import {
  HUB_BOARD_COLUMNS,
  HUB_STAGE_GROUPS,
  HUB_STAGE_LABELS,
  projectBoard,
  type HubBoardColumn,
  type HubBoardCommand,
  type HubMergedProjectView,
  type HubSdlcMode,
  type HubSdlcStage,
  type HubStrategyPriority,
  type HubTask,
} from "@t3tools/contracts";

import { labelOf, PRIORITY_OPTIONS, STATUS_OPTIONS } from "./hubFormat.ts";

export type StageColumn = {
  readonly id: string;
  readonly label: string;
  readonly stages: ReadonlyArray<HubSdlcStage>;
};

export function stageColumns(mode: HubSdlcMode): ReadonlyArray<StageColumn> {
  if (mode === "three") return HUB_STAGE_GROUPS;
  return (Object.keys(HUB_STAGE_LABELS) as HubSdlcStage[]).map((stage) => ({
    id: stage,
    label: HUB_STAGE_LABELS[stage],
    stages: [stage],
  }));
}

/** Buckets rows by column, keeping their incoming (rank) order inside each column. */
export function groupByStageColumn<
  T extends { readonly project: { readonly stage: HubSdlcStage } },
>(
  rows: ReadonlyArray<T>,
  columns: ReadonlyArray<StageColumn>,
): ReadonlyMap<string, ReadonlyArray<T>> {
  const grouped = new Map<string, T[]>(columns.map((column) => [column.id, []]));
  for (const row of rows) {
    const column = columns.find((entry) => entry.stages.includes(row.project.stage));
    if (column) grouped.get(column.id)?.push(row);
  }
  return grouped;
}

/** The stage a drop writes, or null when the project is already in that column. */
export function stageForDrop(current: HubSdlcStage, column: StageColumn): HubSdlcStage | null {
  return column.stages.includes(current) ? null : (column.stages[0] ?? null);
}

/** One line under a stage card; the stage itself is the column, so it is left out. */
export function stageCardGlance(
  view: Pick<HubMergedProjectView, "project" | "handoff">,
  strategy: ReadonlyArray<HubStrategyPriority>,
): string {
  const { project, handoff } = view;
  return [
    strategy.find((priority) => priority.id === project.strategyId)?.title,
    project.priority === "none" ? null : labelOf(PRIORITY_OPTIONS, project.priority),
    project.status === "active" ? null : labelOf(STATUS_OPTIONS, project.status),
    handoff?.kind === "ready" || handoff?.kind === "fix" ? "Needs you" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

const OPEN_FIRST: ReadonlyArray<HubBoardColumn> = [
  ...HUB_BOARD_COLUMNS.filter((column) => column !== "done"),
  "done",
];

/** A card's checklist: open tasks in board order, then done ones. */
export function stageCardTasks(tasks: ReadonlyArray<HubTask>): ReadonlyArray<HubTask> {
  const projected = projectBoard(tasks);
  return OPEN_FIRST.flatMap((column) => projected[column]);
}

/** Ticking moves a task to the end of Done; unticking moves it to the end of Todo. */
export function taskToggleCommand(
  tasks: ReadonlyArray<HubTask>,
  task: HubTask,
  done: boolean,
): Extract<HubBoardCommand, { type: "move" }> {
  const toColumn: HubBoardColumn = done ? "done" : "todo";
  const others = projectBoard(tasks)[toColumn].filter((entry) => entry.id !== task.id);
  return {
    type: "move",
    projectId: task.projectId,
    taskId: task.id,
    toColumn,
    beforeTaskId: null,
    afterTaskId: others.at(-1)?.id ?? null,
  };
}

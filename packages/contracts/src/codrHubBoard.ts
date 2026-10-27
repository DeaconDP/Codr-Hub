/**
 * Codr-Hub per-project kanban contracts. Tasks are sibling portfolio files and
 * never enter HubSnapshot. Ready-for-testing is planning, not TestHandoff.
 *
 * @module codrHubBoard
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HubPriority, HubProjectStatus } from "./codrHub.ts";

export const HUB_BOARD_COLUMNS = ["todo", "in_progress", "ready_for_testing", "done"] as const;
export type HubBoardColumn = (typeof HUB_BOARD_COLUMNS)[number];
export const HubBoardColumn = Schema.Literals(["todo", "in_progress", "ready_for_testing", "done"]);

/** Deez-PM's five columns collapse onto Hub's four. */
export const DEEZ_COLUMN_TO_HUB = {
  Backlog: "todo",
  Priority: "todo",
  Doing: "in_progress",
  Testing: "ready_for_testing",
  Done: "done",
} as const satisfies Record<string, HubBoardColumn>;
export type DeezKanbanColumn = keyof typeof DEEZ_COLUMN_TO_HUB;

/** Lexicographic fractional index within a column. Only mintRank / reduceBoard produce these. */
export const HubTaskRank = Schema.String.check(Schema.isNonEmpty()).pipe(
  Schema.brand("HubTaskRank"),
);
export type HubTaskRank = typeof HubTaskRank.Type;

export const HubTask = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  description: Schema.String,
  column: HubBoardColumn,
  rank: HubTaskRank,
  priority: HubPriority,
  deezCardId: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HubTask = typeof HubTask.Type;

export const HubBoardProjectSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  status: HubProjectStatus,
});
export type HubBoardProjectSummary = typeof HubBoardProjectSummary.Type;

/** Wire payload for hub.board.subscribe / apply. Tasks are unordered; projectBoard sorts. */
export const HubBoardSnapshot = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  project: HubBoardProjectSummary,
  /** Monotonic per-process revision for UI reconciliation; not persisted. */
  revision: NonNegativeInt,
  tasks: Schema.Array(HubTask),
});
export type HubBoardSnapshot = typeof HubBoardSnapshot.Type;

export type HubBoardProjection = {
  readonly [K in HubBoardColumn]: ReadonlyArray<HubTask>;
};

/** Group and sort by opaque rank. Shared by server and board UI. */
export function projectBoard(
  tasks: ReadonlyArray<HubTask> | ReadonlyMap<string, HubTask>,
): HubBoardProjection {
  // Explicit HubTask[]: Array.isArray narrows ReadonlyArray to any[].
  const list: HubTask[] = Array.isArray(tasks) ? [...tasks] : [...tasks.values()];
  const projected: { [K in HubBoardColumn]: HubTask[] } = {
    todo: [],
    in_progress: [],
    ready_for_testing: [],
    done: [],
  };
  for (const task of list) {
    projected[task.column].push(task);
  }
  for (const column of HUB_BOARD_COLUMNS) {
    projected[column].sort((a, b) => a.rank.localeCompare(b.rank) || a.id.localeCompare(b.id));
  }
  return projected;
}

export const HubBoardCreate = Schema.Struct({
  type: Schema.Literal("create"),
  projectId: TrimmedNonEmptyString,
  /** Caller mints the id before apply so reduceBoard stays pure. */
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  column: HubBoardColumn,
  description: Schema.optional(Schema.String),
  priority: Schema.optional(HubPriority),
  /** Place before this task; omit or null = append. */
  beforeTaskId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type HubBoardCreate = typeof HubBoardCreate.Type;

export const HubBoardUpdate = Schema.Struct({
  type: Schema.Literal("update"),
  projectId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  patch: Schema.Struct({
    title: Schema.optional(TrimmedNonEmptyString),
    description: Schema.optional(Schema.String),
    priority: Schema.optional(HubPriority),
  }),
});
export type HubBoardUpdate = typeof HubBoardUpdate.Type;

export const HubBoardMove = Schema.Struct({
  type: Schema.Literal("move"),
  projectId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  toColumn: HubBoardColumn,
  beforeTaskId: Schema.NullOr(TrimmedNonEmptyString),
  afterTaskId: Schema.NullOr(TrimmedNonEmptyString),
});
export type HubBoardMove = typeof HubBoardMove.Type;

export const HubBoardDelete = Schema.Struct({
  type: Schema.Literal("delete"),
  projectId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
});
export type HubBoardDelete = typeof HubBoardDelete.Type;

export const HubBoardCommand = Schema.Union([
  HubBoardCreate,
  HubBoardUpdate,
  HubBoardMove,
  HubBoardDelete,
]);
export type HubBoardCommand = typeof HubBoardCommand.Type;

export const HubBoardSubscribeInput = Schema.Struct({
  projectId: TrimmedNonEmptyString,
});
export type HubBoardSubscribeInput = typeof HubBoardSubscribeInput.Type;

/** apply accepts the command union directly. */
export type HubBoardApplyInput = HubBoardCommand;

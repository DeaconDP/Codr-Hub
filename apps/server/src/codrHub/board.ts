/**
 * Pure per-project kanban algebra. Ranks are opaque fractional lex strings;
 * only mintRank / reduceBoard invent them. Ready-for-testing is planning, not
 * TestHandoff.
 *
 * @module codrHub/board
 */
import {
  DEEZ_COLUMN_TO_HUB,
  projectBoard,
  type DeezKanbanColumn,
  type HubBoardColumn,
  type HubBoardCommand,
  type HubPriority,
  type HubTask,
  type HubTaskRank,
} from "@t3tools/contracts";

export { projectBoard };

export type HubBoardTouched =
  | { readonly op: "write"; readonly task: HubTask }
  | { readonly op: "delete"; readonly taskId: string };

export type HubBoardError =
  | { readonly _tag: "TaskNotFound"; readonly taskId: string }
  | { readonly _tag: "CrossProject"; readonly taskId: string }
  | { readonly _tag: "InvalidPlacement"; readonly reason: string }
  | { readonly _tag: "DuplicateTask"; readonly taskId: string };

export type ReduceBoardResult =
  | {
      readonly ok: true;
      readonly tasks: ReadonlyMap<string, HubTask>;
      readonly touched: ReadonlyArray<HubBoardTouched>;
    }
  | { readonly ok: false; readonly error: HubBoardError };

/** Base-62 digits; lexicographic order matches numeric order of digit indices. */
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" as const;
const DIGIT_INDEX = new Map([...DIGITS].map((ch, i) => [ch, i] as const));
const BASE = DIGITS.length;

const asRank = (value: string): HubTaskRank => value as HubTaskRank;

const digitAt = (rank: string, index: number): number => {
  if (index >= rank.length) return 0;
  return DIGIT_INDEX.get(rank[index]!) ?? 0;
};

/**
 * Midpoint (or append/prepend) between optional same-column neighbors.
 * `after` is the preceding card (null = start); `before` is the following card (null = end).
 */
export function mintRank(after: HubTaskRank | null, before: HubTaskRank | null): HubTaskRank {
  if (after !== null && before !== null && after >= before) {
    return mintRank(after, null);
  }
  if (after === null && before === null) return asRank("a0");
  if (before === null) return asRank(appendAfter(after!));
  if (after === null) return asRank(prependBefore(before));
  return asRank(between(after, before));
}

function appendAfter(after: string): string {
  // Prefer bumping the last digit; when the suffix is saturated, lengthen.
  const chars = [...after];
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const idx = DIGIT_INDEX.get(chars[i]!) ?? 0;
    if (idx + 1 < BASE) {
      chars[i] = DIGITS[idx + 1]!;
      for (let j = i + 1; j < chars.length; j += 1) chars[j] = "0";
      return chars.join("");
    }
  }
  return `${after}V`;
}

function prependBefore(before: string): string {
  const chars = [...before];
  for (let i = 0; i < chars.length; i += 1) {
    const idx = DIGIT_INDEX.get(chars[i]!) ?? 0;
    if (idx > 0) {
      chars[i] = DIGITS[idx - 1]!;
      for (let j = i + 1; j < chars.length; j += 1) chars[j] = "z";
      const candidate = chars.join("");
      if (candidate < before) return candidate;
    }
  }
  return `0${before}`;
}

function between(after: string, before: string): string {
  let prefix = "";
  for (let i = 0; ; i += 1) {
    const a = digitAt(after, i);
    const b = i < before.length ? digitAt(before, i) : BASE;
    if (b - a > 1) {
      return `${prefix}${DIGITS[Math.floor((a + b) / 2)]}`;
    }
    prefix += DIGITS[a]!;
    if (i > Math.max(after.length, before.length) + 16) {
      // Adjacent forever; open a new digit under `after`.
      return `${prefix}V`;
    }
  }
}

export function mapDeezColumn(column: string): HubBoardColumn {
  return DEEZ_COLUMN_TO_HUB[column as DeezKanbanColumn] ?? "todo";
}

const PRIORITY_FROM_DEEZ: Record<string, HubPriority> = {
  Default: "none",
  Low: "low",
  Med: "medium",
  High: "high",
  Crit: "critical",
};

export type DeezTaskInput = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly column: string;
  readonly priority: string;
  readonly comments?: ReadonlyArray<{ readonly body: string }>;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** Fold Deez comments into description; preserve Deez card id for re-import skip. */
export function hubTaskFromDeez(
  deez: DeezTaskInput,
  hubProjectId: string,
  rank: HubTaskRank,
): HubTask {
  const commentText = (deez.comments ?? [])
    .map((comment) => comment.body.trim())
    .filter((body) => body !== "")
    .join("\n\n");
  const base = deez.description.trim();
  const description =
    base === "" ? commentText : commentText === "" ? base : `${base}\n\n${commentText}`;
  return {
    id: deez.id,
    projectId: hubProjectId,
    title: deez.title.trim() || "Untitled",
    description,
    column: mapDeezColumn(deez.column),
    rank,
    priority: PRIORITY_FROM_DEEZ[deez.priority] ?? "none",
    deezCardId: deez.id,
    createdAt: deez.createdAt,
    updatedAt: deez.updatedAt,
  };
}

function tasksForProject(current: ReadonlyMap<string, HubTask>, projectId: string): HubTask[] {
  return [...current.values()].filter((task) => task.projectId === projectId);
}

function requireTask(
  current: ReadonlyMap<string, HubTask>,
  projectId: string,
  taskId: string,
): { ok: true; task: HubTask } | { ok: false; error: HubBoardError } {
  const task = current.get(taskId);
  if (!task) return { ok: false, error: { _tag: "TaskNotFound", taskId } };
  if (task.projectId !== projectId) return { ok: false, error: { _tag: "CrossProject", taskId } };
  return { ok: true, task };
}

function neighborRank(
  projected: ReturnType<typeof projectBoard>,
  column: HubBoardColumn,
  neighborId: string | null | undefined,
  role: "before" | "after",
): { ok: true; rank: HubTaskRank | null } | { ok: false; error: HubBoardError } {
  if (neighborId === null || neighborId === undefined) return { ok: true, rank: null };
  const neighbor = projected[column].find((task) => task.id === neighborId);
  if (!neighbor) {
    return {
      ok: false,
      error: {
        _tag: "InvalidPlacement",
        reason: `${role} neighbor ${neighborId} is not in ${column}`,
      },
    };
  }
  return { ok: true, rank: neighbor.rank };
}

/**
 * Idempotent where possible: same move neighbors → same rank → empty touch list.
 * Never trusts a client-supplied HubTaskRank.
 */
export function reduceBoard(
  current: ReadonlyMap<string, HubTask>,
  command: HubBoardCommand,
  now: string,
): ReduceBoardResult {
  switch (command.type) {
    case "create":
      return reduceCreate(current, command, now);
    case "update":
      return reduceUpdate(current, command, now);
    case "move":
      return reduceMove(current, command, now);
    case "delete":
      return reduceDelete(current, command);
  }
}

function reduceCreate(
  current: ReadonlyMap<string, HubTask>,
  command: Extract<HubBoardCommand, { type: "create" }>,
  now: string,
): ReduceBoardResult {
  if (current.has(command.id)) {
    return { ok: false, error: { _tag: "DuplicateTask", taskId: command.id } };
  }
  const projectTasks = tasksForProject(current, command.projectId);
  const projected = projectBoard(projectTasks);
  const before = neighborRank(projected, command.column, command.beforeTaskId, "before");
  if (!before.ok) return before;
  const columnTasks = projected[command.column];
  let afterRank: HubTaskRank | null = null;
  if (command.beforeTaskId) {
    const index = columnTasks.findIndex((task) => task.id === command.beforeTaskId);
    afterRank = index > 0 ? columnTasks[index - 1]!.rank : null;
  } else if (columnTasks.length > 0) {
    afterRank = columnTasks[columnTasks.length - 1]!.rank;
  }
  const task: HubTask = {
    id: command.id,
    projectId: command.projectId,
    title: command.title,
    description: command.description ?? "",
    column: command.column,
    rank: mintRank(afterRank, before.rank),
    priority: command.priority ?? "none",
    deezCardId: null,
    createdAt: now,
    updatedAt: now,
  };
  const next = new Map(current);
  next.set(task.id, task);
  return { ok: true, tasks: next, touched: [{ op: "write", task }] };
}

function reduceUpdate(
  current: ReadonlyMap<string, HubTask>,
  command: Extract<HubBoardCommand, { type: "update" }>,
  now: string,
): ReduceBoardResult {
  const found = requireTask(current, command.projectId, command.taskId);
  if (!found.ok) return found;
  const { title, description, priority } = command.patch;
  if (title === undefined && description === undefined && priority === undefined) {
    return { ok: true, tasks: current, touched: [] };
  }
  const task: HubTask = {
    ...found.task,
    title: title ?? found.task.title,
    description: description ?? found.task.description,
    priority: priority ?? found.task.priority,
    updatedAt: now,
  };
  if (
    task.title === found.task.title &&
    task.description === found.task.description &&
    task.priority === found.task.priority
  ) {
    return { ok: true, tasks: current, touched: [] };
  }
  const next = new Map(current);
  next.set(task.id, task);
  return { ok: true, tasks: next, touched: [{ op: "write", task }] };
}

function reduceMove(
  current: ReadonlyMap<string, HubTask>,
  command: Extract<HubBoardCommand, { type: "move" }>,
  now: string,
): ReduceBoardResult {
  const found = requireTask(current, command.projectId, command.taskId);
  if (!found.ok) return found;
  if (command.beforeTaskId === command.taskId || command.afterTaskId === command.taskId) {
    return {
      ok: false,
      error: { _tag: "InvalidPlacement", reason: "A task cannot be its own neighbor." },
    };
  }
  const others = tasksForProject(current, command.projectId).filter(
    (task) => task.id !== command.taskId,
  );
  const projected = projectBoard(others);
  const before = neighborRank(projected, command.toColumn, command.beforeTaskId, "before");
  if (!before.ok) return before;
  const after = neighborRank(projected, command.toColumn, command.afterTaskId, "after");
  if (!after.ok) return after;
  if (after.rank !== null && before.rank !== null && after.rank >= before.rank) {
    return {
      ok: false,
      error: {
        _tag: "InvalidPlacement",
        reason: "after neighbor must sort before the before neighbor",
      },
    };
  }
  const rank = mintRank(after.rank, before.rank);
  if (found.task.column === command.toColumn && found.task.rank === rank) {
    return { ok: true, tasks: current, touched: [] };
  }
  const task: HubTask = {
    ...found.task,
    column: command.toColumn,
    rank,
    updatedAt: now,
  };
  const next = new Map(current);
  next.set(task.id, task);
  return { ok: true, tasks: next, touched: [{ op: "write", task }] };
}

function reduceDelete(
  current: ReadonlyMap<string, HubTask>,
  command: Extract<HubBoardCommand, { type: "delete" }>,
): ReduceBoardResult {
  const found = requireTask(current, command.projectId, command.taskId);
  if (!found.ok) return found;
  const next = new Map(current);
  next.delete(command.taskId);
  return { ok: true, tasks: next, touched: [{ op: "delete", taskId: command.taskId }] };
}

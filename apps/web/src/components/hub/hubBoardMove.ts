import { arrayMove } from "@dnd-kit/sortable";
import type { HubTask } from "@t3tools/contracts";

/** Neighbors for hub.board.apply move. after = lower rank, before = higher rank. */
export function moveNeighbors(input: {
  readonly destTasks: ReadonlyArray<Pick<HubTask, "id">>;
  readonly activeId: string;
  /** Task id to place relative to, or null to append. */
  readonly overTaskId: string | null;
}): { readonly beforeTaskId: string | null; readonly afterTaskId: string | null } {
  const ids = input.destTasks.map((task) => task.id);
  const fromIndex = ids.indexOf(input.activeId);

  if (input.overTaskId === null) {
    const others = ids.filter((id) => id !== input.activeId);
    return { beforeTaskId: null, afterTaskId: others[others.length - 1] ?? null };
  }

  const overIndex = ids.indexOf(input.overTaskId);
  if (overIndex === -1) {
    const others = ids.filter((id) => id !== input.activeId);
    return { beforeTaskId: null, afterTaskId: others[others.length - 1] ?? null };
  }

  if (fromIndex !== -1) {
    const next = arrayMove(ids, fromIndex, overIndex);
    const index = next.indexOf(input.activeId);
    return {
      afterTaskId: index > 0 ? (next[index - 1] ?? null) : null,
      beforeTaskId: index < next.length - 1 ? (next[index + 1] ?? null) : null,
    };
  }

  return {
    afterTaskId: overIndex > 0 ? (ids[overIndex - 1] ?? null) : null,
    beforeTaskId: input.overTaskId,
  };
}

export function isSamePlacement(input: {
  readonly columnTasks: ReadonlyArray<Pick<HubTask, "id">>;
  readonly taskId: string;
  readonly beforeTaskId: string | null;
  readonly afterTaskId: string | null;
}): boolean {
  const ids = input.columnTasks.map((task) => task.id);
  const index = ids.indexOf(input.taskId);
  if (index === -1) return false;
  const afterTaskId = index > 0 ? (ids[index - 1] ?? null) : null;
  const beforeTaskId = index < ids.length - 1 ? (ids[index + 1] ?? null) : null;
  return afterTaskId === input.afterTaskId && beforeTaskId === input.beforeTaskId;
}

import { describe, expect, it } from "vitest";

import {
  hubTaskFromDeez,
  mapDeezColumn,
  mintRank,
  projectBoard,
  reduceBoard,
  type HubBoardTouched,
} from "./board.ts";
import type { HubTask, HubTaskRank } from "@t3tools/contracts";

const NOW = "2026-10-27T10:00:00.000Z";
const rank = (value: string) => value as HubTaskRank;

const task = (overrides: Partial<HubTask> & Pick<HubTask, "id" | "rank" | "column">): HubTask => ({
  projectId: "emily",
  title: overrides.id,
  description: "",
  priority: "none",
  deezCardId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const mapOf = (...tasks: HubTask[]) => new Map(tasks.map((entry) => [entry.id, entry]));

const written = (touched: ReadonlyArray<HubBoardTouched>) =>
  touched.filter(
    (entry): entry is Extract<HubBoardTouched, { op: "write" }> => entry.op === "write",
  );

describe("mintRank", () => {
  it("starts an empty column near the middle of the alphabet", () => {
    expect(mintRank(null, null)).toBe("a0");
  });

  it("places a card between two neighbors", () => {
    const mid = mintRank(rank("a0"), rank("a2"));
    expect(mid > "a0").toBe(true);
    expect(mid < "a2").toBe(true);
  });

  it("appends after the last card and prepends before the first", () => {
    expect(mintRank(rank("a0"), null) > "a0").toBe(true);
    expect(mintRank(null, rank("a0")) < "a0").toBe(true);
  });

  it("keeps inserting between the same pair without colliding", () => {
    let after = rank("a0");
    const before = rank("a1");
    const ranks = new Set<string>([after, before]);
    for (let i = 0; i < 40; i += 1) {
      const next = mintRank(after, before);
      expect(ranks.has(next)).toBe(false);
      expect(next > after).toBe(true);
      expect(next < before).toBe(true);
      ranks.add(next);
      after = next;
    }
  });
});

describe("projectBoard", () => {
  it("groups by column and sorts by rank then id", () => {
    const projected = projectBoard([
      task({ id: "b", column: "todo", rank: rank("a2") }),
      task({ id: "a", column: "todo", rank: rank("a1") }),
      task({ id: "c", column: "done", rank: rank("a0") }),
    ]);
    expect(projected.todo.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(projected.done.map((entry) => entry.id)).toEqual(["c"]);
    expect(projected.in_progress).toEqual([]);
    expect(projected.ready_for_testing).toEqual([]);
  });
});

describe("mapDeezColumn", () => {
  it("maps Deez five columns onto Hub four", () => {
    expect(mapDeezColumn("Backlog")).toBe("todo");
    expect(mapDeezColumn("Priority")).toBe("todo");
    expect(mapDeezColumn("Doing")).toBe("in_progress");
    expect(mapDeezColumn("Testing")).toBe("ready_for_testing");
    expect(mapDeezColumn("Done")).toBe("done");
    expect(mapDeezColumn("Mystery")).toBe("todo");
  });
});

describe("hubTaskFromDeez", () => {
  it("folds comments into description and stores deezCardId", () => {
    const hub = hubTaskFromDeez(
      {
        id: "card-1",
        title: "Ship board",
        description: "Body",
        column: "Doing",
        priority: "High",
        comments: [{ body: "note one" }, { body: "note two" }],
        createdAt: NOW,
        updatedAt: NOW,
      },
      "emily",
      rank("a0"),
    );
    expect(hub.column).toBe("in_progress");
    expect(hub.priority).toBe("high");
    expect(hub.deezCardId).toBe("card-1");
    expect(hub.description).toBe("Body\n\nnote one\n\nnote two");
  });
});

describe("reduceBoard", () => {
  it("creates, moves, updates, and deletes a card", () => {
    const created = reduceBoard(
      new Map(),
      {
        type: "create",
        projectId: "emily",
        id: "t1",
        title: "First",
        column: "todo",
      },
      NOW,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(written(created.touched)).toHaveLength(1);
    expect(created.tasks.get("t1")?.rank).toBe("a0");

    const second = reduceBoard(
      created.tasks,
      {
        type: "create",
        projectId: "emily",
        id: "t2",
        title: "Second",
        column: "todo",
      },
      NOW,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const ordered = projectBoard(second.tasks).todo.map((entry) => entry.id);
    expect(ordered).toEqual(["t1", "t2"]);

    const moved = reduceBoard(
      second.tasks,
      {
        type: "move",
        projectId: "emily",
        taskId: "t2",
        toColumn: "in_progress",
        beforeTaskId: null,
        afterTaskId: null,
      },
      "2026-10-27T11:00:00.000Z",
    );
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.tasks.get("t2")?.column).toBe("in_progress");
    expect(written(moved.touched)).toHaveLength(1);

    const updated = reduceBoard(
      moved.tasks,
      {
        type: "update",
        projectId: "emily",
        taskId: "t1",
        patch: { title: "Renamed", priority: "high" },
      },
      "2026-10-27T12:00:00.000Z",
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.tasks.get("t1")?.title).toBe("Renamed");
    expect(updated.tasks.get("t1")?.priority).toBe("high");

    const deleted = reduceBoard(
      updated.tasks,
      { type: "delete", projectId: "emily", taskId: "t1" },
      NOW,
    );
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.tasks.has("t1")).toBe(false);
    expect(deleted.touched).toEqual([{ op: "delete", taskId: "t1" }]);
  });

  it("inserts before a neighbor and no-ops an identical move", () => {
    const a = task({ id: "a", column: "todo", rank: rank("a0") });
    const c = task({ id: "c", column: "todo", rank: rank("a2") });
    const created = reduceBoard(
      mapOf(a, c),
      {
        type: "create",
        projectId: "emily",
        id: "b",
        title: "Between",
        column: "todo",
        beforeTaskId: "c",
      },
      NOW,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const ids = projectBoard(created.tasks).todo.map((entry) => entry.id);
    expect(ids).toEqual(["a", "b", "c"]);
    const b = created.tasks.get("b")!;

    const again = reduceBoard(
      created.tasks,
      {
        type: "move",
        projectId: "emily",
        taskId: "b",
        toColumn: "todo",
        beforeTaskId: "c",
        afterTaskId: "a",
      },
      NOW,
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.touched).toEqual([]);
    expect(again.tasks.get("b")?.rank).toBe(b.rank);
  });

  it("rejects cross-project and missing neighbors", () => {
    const local = task({ id: "a", column: "todo", rank: rank("a0") });
    const foreign = task({
      id: "x",
      projectId: "other",
      column: "todo",
      rank: rank("a0"),
    });
    const cross = reduceBoard(
      mapOf(local, foreign),
      {
        type: "move",
        projectId: "emily",
        taskId: "x",
        toColumn: "done",
        beforeTaskId: null,
        afterTaskId: null,
      },
      NOW,
    );
    expect(cross).toEqual({ ok: false, error: { _tag: "CrossProject", taskId: "x" } });

    const badNeighbor = reduceBoard(
      mapOf(local),
      {
        type: "move",
        projectId: "emily",
        taskId: "a",
        toColumn: "todo",
        beforeTaskId: "missing",
        afterTaskId: null,
      },
      NOW,
    );
    expect(badNeighbor.ok).toBe(false);
    if (badNeighbor.ok) return;
    expect(badNeighbor.error._tag).toBe("InvalidPlacement");
  });
});

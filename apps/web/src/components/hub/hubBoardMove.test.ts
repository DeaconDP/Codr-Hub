import { describe, expect, it } from "vite-plus/test";

import { moveNeighbors } from "./hubBoardMove";

const tasks = (...ids: string[]) => ids.map((id) => ({ id }));

describe("moveNeighbors", () => {
  it("appends with after = last other task", () => {
    expect(
      moveNeighbors({ destTasks: tasks("a", "b", "c"), activeId: "x", overTaskId: null }),
    ).toEqual({ beforeTaskId: null, afterTaskId: "c" });
  });

  it("reorders within a column via arrayMove neighbors", () => {
    expect(
      moveNeighbors({ destTasks: tasks("a", "b", "c"), activeId: "a", overTaskId: "c" }),
    ).toEqual({ beforeTaskId: null, afterTaskId: "c" });
    expect(
      moveNeighbors({ destTasks: tasks("a", "b", "c"), activeId: "c", overTaskId: "a" }),
    ).toEqual({ beforeTaskId: "a", afterTaskId: null });
  });

  it("inserts before the over task when crossing columns", () => {
    expect(moveNeighbors({ destTasks: tasks("a", "b"), activeId: "x", overTaskId: "b" })).toEqual({
      beforeTaskId: "b",
      afterTaskId: "a",
    });
  });
});

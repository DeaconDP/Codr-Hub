import type { HubBoardColumn, HubSdlcStage, HubTask, HubTaskRank } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupByStageColumn,
  stageCardTasks,
  stageColumns,
  stageForDrop,
  taskToggleCommand,
} from "./stageBoardModel.ts";

const task = (id: string, column: HubBoardColumn, rank: string): HubTask => ({
  id,
  projectId: "emily",
  title: id,
  description: "",
  column,
  rank: rank as HubTaskRank,
  priority: "none",
  deezCardId: null,
  createdAt: "2026-11-05T00:00:00.000Z",
  updatedAt: "2026-11-05T00:00:00.000Z",
});

const row = (id: string, stage: HubSdlcStage) => ({ id, project: { stage } });

describe("stage board", () => {
  it("groups paired stages into three columns and keeps rank order", () => {
    const columns = stageColumns("three");
    const grouped = groupByStageColumn(
      [row("a", "release"), row("b", "plan"), row("c", "design"), row("d", "maintain")],
      columns,
    );
    expect([...grouped.entries()].map(([id, rows]) => [id, rows.map((entry) => entry.id)])).toEqual(
      [
        ["plan-design", ["b", "c"]],
        ["dev-test", []],
        ["maintain-improve", ["a", "d"]],
      ],
    );
  });

  it("writes a stage only when the drop changes column", () => {
    const [planDesign, devTest] = stageColumns("three");
    expect(stageForDrop("design", planDesign!)).toBeNull();
    expect(stageForDrop("design", devTest!)).toBe("develop");
    const six = stageColumns("six");
    expect(six.map((column) => column.id)).toEqual([
      "plan",
      "design",
      "develop",
      "test",
      "release",
      "maintain",
    ]);
    expect(stageForDrop("plan", six[1]!)).toBe("design");
  });

  it("lists open tasks first and ticks or unticks onto the end of the target column", () => {
    const tasks = [
      task("shipped", "done", "a1"),
      task("later", "todo", "a2"),
      task("now", "in_progress", "a1"),
      task("first", "todo", "a1"),
      task("older", "done", "a0"),
    ];
    expect(stageCardTasks(tasks).map((entry) => entry.id)).toEqual([
      "first",
      "later",
      "now",
      "older",
      "shipped",
    ]);
    expect(taskToggleCommand(tasks, tasks[2]!, true)).toMatchObject({
      toColumn: "done",
      afterTaskId: "shipped",
      beforeTaskId: null,
    });
    expect(taskToggleCommand(tasks, tasks[0]!, false)).toMatchObject({
      toColumn: "todo",
      afterTaskId: "later",
    });
    expect(taskToggleCommand([tasks[1]!], tasks[1]!, false).afterTaskId).toBeNull();
  });
});

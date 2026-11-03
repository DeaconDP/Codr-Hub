import type { HubProject } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hubProjectMenuActions, hubProjectPatchForAction } from "./hubProjectMenu";

const project = {
  priority: "high",
  status: "active",
  stage: "test",
  strategyId: "gone",
  archived: false,
} as HubProject;
const strategy = [{ id: "ship:v1", title: "Ship v1", notes: "" }];

const selected = (actions: ReturnType<typeof hubProjectMenuActions>, id: string) =>
  actions.find((action) => action.id === id)?.subactions?.find((sub) => sub.state === "on")?.id;

describe("hub project menu", () => {
  it("marks a stored stage by its three-stage group and a deleted strategy as none", () => {
    const actions = hubProjectMenuActions(project, strategy, "three");
    expect(selected(actions, "priority")).toBe("priority:high");
    expect(selected(actions, "stage")).toBe("stage:develop");
    expect(selected(actions, "strategy")).toBe("strategy:none");
  });

  it("leaves Strategy out when there are no priorities and offers the way back from Archive", () => {
    const archived = { ...project, archived: true };
    const ids = hubProjectMenuActions(archived, [], "six").map((action) => action.id);
    expect(ids).toEqual(["priority", "status", "stage", "unarchive"]);
    expect(hubProjectPatchForAction("unarchive", "six")).toEqual({ archived: false });
  });

  it("turns chosen ids into writes, keeping colons in strategy ids", () => {
    expect(hubProjectPatchForAction("priority:critical", "three")).toEqual({
      priority: "critical",
    });
    expect(hubProjectPatchForAction("strategy:ship:v1", "three")).toEqual({
      strategyId: "ship:v1",
    });
    expect(hubProjectPatchForAction("strategy:none", "three")).toEqual({ strategyId: null });
  });

  it("rejects values the menu never offers, including a fine stage in three-stage mode", () => {
    expect(hubProjectPatchForAction("stage:test", "three")).toBeNull();
    expect(hubProjectPatchForAction("stage:test", "six")).toEqual({ stage: "test" });
    expect(hubProjectPatchForAction("priority:urgent", "three")).toBeNull();
    expect(hubProjectPatchForAction("priority", "three")).toBeNull();
  });
});

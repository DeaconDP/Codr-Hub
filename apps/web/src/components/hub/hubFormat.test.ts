import type { HubMergedProjectView, HubProject } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterAndSortProjects, newStrategyId, stageOptions, stageSelectValue } from "./hubFormat";

const view = (
  overrides: Partial<HubProject>,
  lastLaunchAt: string | null = null,
): HubMergedProjectView => ({
  project: {
    id: "p",
    name: "P",
    priority: "medium",
    status: "active",
    stage: "develop",
    strategyId: null,
    category: null,
    tags: [],
    repoUrl: null,
    notes: "",
    hosts: {},
    autonomy: 0,
    reviewBudget: 2,
    sortIndex: 0,
    favorite: false,
    archived: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  },
  nodes:
    lastLaunchAt === null
      ? []
      : [
          {
            nodeName: "local",
            localPath: null,
            pathExists: false,
            git: null,
            awaitingReview: 0,
            running: 0,
            lastLaunchAt,
          },
        ],
});

const views = [
  view({ id: "a", name: "Alpha", priority: "low", tags: ["Web"] }),
  view({ id: "b", name: "Bravo", priority: "high", strategyId: "s1" }),
  view({ id: "c", name: "Charlie", status: "done" }, "2026-10-05T00:00:00.000Z"),
  view({ id: "d", name: "Delta", archived: true }),
];
const ids = (list: HubMergedProjectView[]) => list.map((entry) => entry.project.id);
const base = { query: "", sort: "rank" as const, strategy: [{ id: "s1", title: "S", notes: "" }] };

describe("hub project list", () => {
  it("shows open work by default, ranked by strategy then priority", () => {
    expect(ids(filterAndSortProjects(views, { ...base, filter: "open" }))).toEqual(["b", "a"]);
  });

  it("filters by status, archive, and search over name and tags", () => {
    expect(ids(filterAndSortProjects(views, { ...base, filter: "done" }))).toEqual(["c"]);
    expect(ids(filterAndSortProjects(views, { ...base, filter: "archived" }))).toEqual(["d"]);
    expect(ids(filterAndSortProjects(views, { ...base, filter: "all", query: "web" }))).toEqual([
      "a",
    ]);
  });

  it("sorts by name or most recent activity", () => {
    expect(ids(filterAndSortProjects(views, { ...base, filter: "all", sort: "name" }))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(ids(filterAndSortProjects(views, { ...base, filter: "all", sort: "recent" }))[0]).toBe(
      "c",
    );
  });
});

describe("hub stages", () => {
  it("maps fine stages onto three-stage groups without losing them in six-stage mode", () => {
    expect(stageOptions("three").map((option) => option.label)).toEqual([
      "Plan & Design",
      "Dev & Test",
      "Maintain & Improve",
    ]);
    expect(stageSelectValue("test", "three")).toBe("develop");
    expect(stageSelectValue("test", "six")).toBe("test");
  });
});

describe("strategy ids", () => {
  it("slugifies and suffixes so concurrent adds do not collide", () => {
    expect(newStrategyId("Ship Emily-OS v1!", "abcdef123")).toBe("ship-emily-os-v1-abcdef");
    expect(newStrategyId("!!!", "zzzzzz")).toBe("priority-zzzzzz");
  });
});

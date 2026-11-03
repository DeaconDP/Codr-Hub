import type { HubMergedProjectView, HubPace, HubProject } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterAndSortProjects,
  formatTimeUntilLabel,
  newStrategyId,
  paceSummary,
  projectGlance,
  stageOptions,
  stageSelectValue,
  t3SyncSummary,
} from "./hubFormat.ts";

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
    previewUrl: null,
    liveUrl: null,
    siteId: null,
    surface: null,
    notes: "",
    hosts: {},
    autonomy: 0,
    reviewBudget: 2,
    sortIndex: 0,
    favorite: false,
    archived: false,
    lane: null,
    jobKind: "dev",
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
  handoff: null,
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

  it("filters by lane without changing rank", () => {
    const ranked = filterAndSortProjects(
      [
        view({ id: "open-missing", name: "Missing", lane: null, priority: "critical" }),
        view({ id: "immersion", name: "Immerse", lane: "immersion", priority: "low" }),
        view({ id: "automation", name: "Auto", lane: "automation", priority: "high" }),
      ],
      { ...base, filter: "all", lane: "immersion" },
    );
    expect(ids(ranked)).toEqual(["immersion"]);
    expect(ids(filterAndSortProjects(views, { ...base, filter: "all", lane: null }))).toEqual(
      ids(filterAndSortProjects(views, { ...base, filter: "all" })),
    );
  });

  it("sorts by favourite, priority, or status, keeping rank within each group", () => {
    const grouped = [
      view({ id: "low-fav", name: "A", priority: "low", favorite: true, status: "paused" }),
      view({ id: "high", name: "B", priority: "high", status: "idea" }),
      view({ id: "medium", name: "C", priority: "medium", status: "active" }),
      view({ id: "crit-fav", name: "D", priority: "critical", favorite: true, status: "idea" }),
    ];
    const sorted = (sort: "favorites" | "priority" | "status") =>
      ids(filterAndSortProjects(grouped, { ...base, filter: "all", sort }));
    expect(sorted("favorites")).toEqual(["crit-fav", "low-fav", "high", "medium"]);
    expect(sorted("priority")).toEqual(["crit-fav", "high", "medium", "low-fav"]);
    expect(sorted("status")).toEqual(["medium", "crit-fav", "high", "low-fav"]);
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

describe("project glance", () => {
  const strategy = [{ id: "s1", title: "Ship Emily-OS", notes: "" }];
  const glance = (
    project: ReturnType<typeof view>["project"],
    nodes: ReturnType<typeof view>["nodes"] = [
      {
        nodeName: "Steve",
        localPath: "/work/app",
        pathExists: true,
        git: { branch: "main", ahead: 0, behind: 0, dirty: false, hasUpstream: true },
        awaitingReview: 0,
        running: 0,
        lastLaunchAt: null,
      },
    ],
  ) =>
    projectGlance({
      project,
      nodes,
      selectedNodeName: "Steve",
      strategy,
      mode: "three",
    });

  it("hides Off and the default stage so the checkout is the line", () => {
    expect(glance(view({ stage: "plan", autonomy: 0, status: "active" }).project)).toBe("main");
    expect(glance(view({ stage: "plan", status: "paused" }).project)).toBe("Paused · main");
  });

  it("leads with autonomy and the linked strategy", () => {
    expect(glance(view({ strategyId: "s1", autonomy: 25 }).project)).toBe(
      "Plan · Ship Emily-OS · main",
    );
  });

  it("uses the stage when nothing is linked, and flags a missing checkout", () => {
    expect(glance(view({ stage: "develop" }).project, [])).toBe("Dev & Test · No checkout");
    expect(
      glance(view({ stage: "test" }).project, [
        {
          nodeName: "Steve",
          localPath: "/missing",
          pathExists: false,
          git: null,
          awaitingReview: 2,
          running: 0,
          lastLaunchAt: null,
        },
      ]),
    ).toBe("Dev & Test · Path missing · 2 to review");
  });
});

describe("strategy ids", () => {
  it("slugifies and suffixes so concurrent adds do not collide", () => {
    expect(newStrategyId("Ship Emily-OS v1!", "abcdef123")).toBe("ship-emily-os-v1-abcdef");
    expect(newStrategyId("!!!", "zzzzzz")).toBe("priority-zzzzzz");
  });
});

describe("t3SyncSummary", () => {
  it("names only the counts that moved", () => {
    expect(t3SyncSummary({ imported: 2, updated: 0, skipped: 5 })).toBe("Added 2.");
    expect(t3SyncSummary({ imported: 0, updated: 1, skipped: 0, created: 3 })).toBe(
      "Linked 1, added 3 to T3.",
    );
    expect(t3SyncSummary({ imported: 0, updated: 0, skipped: 4, created: 0 })).toBe(
      "Already in step with T3.",
    );
  });
});

describe("pace text", () => {
  const now = Date.parse("2026-11-02T12:00:00.000Z");
  const pace = (patch: Partial<HubPace>) =>
    ({ state: "on_pace", usedPercent: 40, targetPercent: 50, resetsAt: null, ...patch }) as HubPace;

  it.each([
    ["2026-11-02T11:59:00.000Z", "Expired"],
    ["2026-11-02T12:00:03.000Z", "Soon"],
    ["2026-11-02T15:30:00.000Z", "3h left"],
    ["2026-11-05T13:00:00.000Z", "3d left"],
    ["not a date", ""],
  ])("counts down to %s", (at, label) => {
    expect(formatTimeUntilLabel(at, now)).toBe(label);
  });

  it("names the target only when behind, and the reset only when known", () => {
    expect(paceSummary(pace({}), now)).toBe("40% · On pace");
    expect(paceSummary(pace({ state: "behind", resetsAt: "2026-11-02T14:00:00.000Z" }), now)).toBe(
      "40% of 50% · Behind pace · resets 2h left",
    );
    expect(paceSummary(pace({ state: "unavailable", usedPercent: null }), now)).toBe("Unavailable");
  });
});

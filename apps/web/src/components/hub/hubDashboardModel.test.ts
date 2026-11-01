import type {
  HubActivityCounts,
  HubInsights,
  HubMergedProjectView,
  HubPlatform,
  HubProject,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildHubDashboard, importanceWeight, platformFromTags } from "./hubDashboardModel";

const hub = (
  id: string,
  patch: Partial<HubProject>,
  checkouts: ReadonlyArray<[string, boolean]> = [],
): HubMergedProjectView => ({
  project: {
    id,
    name: id,
    priority: "none",
    status: "active",
    stage: "plan",
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
    lane: null,
    jobKind: "dev",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...patch,
  },
  handoff: null,
  nodes: checkouts.map(([nodeName, pathExists]) => ({
    nodeName,
    localPath: pathExists ? `/src/${id}` : null,
    pathExists,
    git: null,
    awaitingReview: 0,
    running: 0,
    lastLaunchAt: null,
  })),
});

const counts = (sevenDays: number): HubActivityCounts => ({
  "24h": 0,
  "7d": sevenDays,
  "30d": sevenDays,
  ytd: sevenDays,
  all: sevenDays,
});

const insights = (
  nodeName: string,
  rows: ReadonlyArray<[string, HubPlatform, number]>,
): HubInsights => ({
  nodeName,
  computedAt: "2026-10-31T00:00:00.000Z",
  projects: rows.map(([projectId, platform, commits]) => ({
    projectId,
    platform,
    commits: counts(commits),
    lastCommitAt: null,
  })),
});

const strategy = [
  { id: "ship", title: "Ship", notes: "" },
  { id: "learn", title: "Learn", notes: "" },
];

const base = {
  insights: [] as HubInsights[],
  strategy,
  mode: "importance" as const,
  window: "7d" as const,
  hiddenPlatforms: new Set<HubPlatform>(),
};

describe("importanceWeight", () => {
  it("ranks priority, then strategy order, then favourites", () => {
    const weight = (patch: Partial<HubProject>) =>
      importanceWeight({ priority: "none", strategyId: null, favorite: false, ...patch }, strategy);
    expect(weight({ priority: "critical" })).toBeGreaterThan(weight({ priority: "high" }));
    expect(weight({ priority: "low" })).toBeGreaterThan(weight({ priority: "none" }));
    expect(weight({ strategyId: "ship" })).toBeGreaterThan(weight({ strategyId: "learn" }));
    expect(weight({ strategyId: "learn" })).toBeGreaterThan(weight({}));
    expect(weight({ strategyId: "gone" })).toBe(weight({}));
    expect(weight({ favorite: true })).toBeGreaterThan(weight({}));
    expect(weight({ priority: "medium", strategyId: "ship" })).toBe(6);
  });
});

describe("platformFromTags", () => {
  it("reads platform tags and falls back to other", () => {
    expect(platformFromTags({ tags: ["Game", "Unity"], category: null })).toBe("unity");
    expect(platformFromTags({ tags: [], category: "Web" })).toBe("web");
    expect(platformFromTags({ tags: ["misc"], category: null })).toBe("other");
  });
});

describe("buildHubDashboard", () => {
  it("places a project under every machine with a checkout or a host entry", () => {
    const dashboard = buildHubDashboard({
      ...base,
      projects: [
        hub("game", {}, [
          ["Steve", true],
          ["Ada", false],
        ]),
        hub("site", { hosts: { Ada: { path: "/src/site" } } }, [["Ada", false]]),
        hub("idea", {}),
        hub("old", { archived: true }, [["Steve", true]]),
      ],
    });
    const byMachine = Object.fromEntries(
      dashboard.machines.map((machine) => [
        machine.nodeName ?? "none",
        machine.tiles.map((tile) => tile.projectId),
      ]),
    );
    expect(byMachine).toEqual({ Steve: ["game"], Ada: ["site"], none: ["idea"] });
    expect(dashboard.machines.at(-1)?.nodeName).toBeNull();
    expect(dashboard.projectCount).toBe(3);
  });

  it("looks up platform and commits per machine, falling back to another node then tags", () => {
    const dashboard = buildHubDashboard({
      ...base,
      mode: "activity",
      projects: [
        hub("game", {}, [
          ["Steve", true],
          ["Ada", true],
        ]),
        hub("app", { tags: ["iOS"] }, [["Ada", true]]),
      ],
      insights: [
        insights("Steve", [["game", "unreal", 12]]),
        insights("Ada", [["game", "unreal", 3]]),
      ],
    });
    const tile = (machine: string, id: string) =>
      dashboard.machines
        .find((entry) => entry.nodeName === machine)
        ?.tiles.find((entry) => entry.projectId === id);
    expect(tile("Steve", "game")?.windowCommits).toBe(12);
    expect(tile("Ada", "game")?.windowCommits).toBe(3);
    expect(tile("Ada", "app")?.platform).toBe("ios");
    expect(tile("Ada", "app")?.windowCommits).toBeNull();
    expect(dashboard.machines.find((m) => m.nodeName === "Ada")?.windowCommits).toBe(3);
  });

  it("sizes by commits in activity mode, keeping quiet projects small, dimmed and last", () => {
    const dashboard = buildHubDashboard({
      ...base,
      mode: "activity",
      projects: [
        hub("quiet", { priority: "critical" }, [["Steve", true]]),
        hub("busy", {}, [["Steve", true]]),
        hub("some", {}, [["Steve", true]]),
      ],
      insights: [
        insights("Steve", [
          ["quiet", "web", 0],
          ["busy", "web", 100],
          ["some", "web", 10],
        ]),
      ],
    });
    const tiles = dashboard.machines[0]!.tiles;
    expect(tiles.map((tile) => tile.projectId)).toEqual(["busy", "some", "quiet"]);
    expect(tiles.map((tile) => tile.dimmed)).toEqual([false, false, true]);
    const quiet = tiles[2]!.weight;
    expect(quiet).toBeGreaterThan(0);
    expect(quiet).toBeLessThan(tiles[1]!.weight);
    expect(dashboard.machines[0]!.weight).toBe(tiles.reduce((sum, tile) => sum + tile.weight, 0));
  });

  it("filters hidden platforms but still counts them for the legend", () => {
    const dashboard = buildHubDashboard({
      ...base,
      hiddenPlatforms: new Set<HubPlatform>(["rust"]),
      projects: [
        hub("cli", { tags: ["rust"] }, [
          ["Steve", true],
          ["Ada", true],
        ]),
        hub("tool", { tags: ["python"] }, [["Steve", true]]),
      ],
    });
    expect(dashboard.platformCounts.rust).toBe(1);
    expect(dashboard.platformCounts.python).toBe(1);
    expect(dashboard.machines.map((machine) => machine.nodeName)).toEqual(["Steve"]);
    expect(dashboard.machines[0]!.tiles.map((tile) => tile.projectId)).toEqual(["tool"]);
  });

  it("orders machines by total weight", () => {
    const dashboard = buildHubDashboard({
      ...base,
      projects: [
        hub("a", { priority: "low" }, [["Small", true]]),
        hub("b", { priority: "critical" }, [["Big", true]]),
      ],
    });
    expect(dashboard.machines.map((machine) => machine.nodeName)).toEqual(["Big", "Small"]);
  });
});

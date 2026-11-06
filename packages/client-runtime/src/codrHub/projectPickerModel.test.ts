import type { EnvironmentId, HubMergedProjectView, HubProject } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  autoMachineColor,
  hubThreadTarget,
  linkPickerRows,
  machineColor,
  parseTags,
  pickerSections,
  pickerWriteFor,
  planPickerReorder,
  rowMatches,
  sortPickerRows,
  t3ProjectForHubView,
} from "./projectPickerModel.ts";

const steve = "env-steve" as EnvironmentId;
const ada = "env-ada" as EnvironmentId;
const nodes = new Map([
  [steve, "Steve"],
  [ada, "Ada"],
]);
// Steve's Hub reads projects from the stock T3 beside it.
const stockT3 = "env-steve-t3" as EnvironmentId;
const nodesWithT3 = new Map([...nodes, [stockT3, "Steve"]]);

const group = (name: string, members: ReadonlyArray<[EnvironmentId, string]>) => ({
  projectKey: `key-${name}`,
  displayName: name,
  memberProjects: members.map(([environmentId, workspaceRoot]) => ({
    environmentId,
    workspaceRoot,
  })),
});

const hub = (
  id: string,
  patch: Partial<HubProject>,
  checkouts: ReadonlyArray<[string, string | null]>,
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
    ...patch,
  },
  handoff: null,
  nodes: checkouts.map(([nodeName, localPath]) => ({
    nodeName,
    localPath,
    pathExists: localPath !== null,
    git: null,
    awaitingReview: 0,
    running: 0,
    lastLaunchAt: null,
  })),
});

describe("linkPickerRows", () => {
  it("links by the checkout path on the member's own node", () => {
    const rows = linkPickerRows(
      [group("Web", [[ada, "/home/d/web/"]]), group("Other", [[steve, "/home/d/web"]])],
      [
        hub("web", {}, [
          ["Steve", null],
          ["Ada", "/home/d/web"],
        ]),
      ],
      nodes,
    );
    expect(rows.map((row) => row.hub?.project.id ?? null)).toEqual(["web", null]);
  });
});

describe("t3ProjectForHubView", () => {
  it("finds the T3 project by checkout path on its own node, never another node's same path", () => {
    const projects = [
      { environmentId: steve, workspaceRoot: "/home/d/web" },
      { environmentId: ada, workspaceRoot: "/home/d/web/" },
    ];
    const view = hub("web", {}, [
      ["Steve", null],
      ["Ada", "/home/d/web"],
    ]);
    expect(t3ProjectForHubView(view, projects, nodes)).toBe(projects[1]);
    expect(t3ProjectForHubView(hub("none", {}, [["Ada", null]]), projects, nodes)).toBeNull();
    const withStock = [...projects, { environmentId: stockT3, workspaceRoot: "/home/d/web" }];
    expect(
      t3ProjectForHubView(hub("web", {}, [["Steve", "/home/d/web"]]), withStock, nodesWithT3),
    ).toBe(withStock[2]);
  });

  it("offers to add an unmatched folder on a connected machine, else names the offline ones", () => {
    const projects = [{ environmentId: steve, workspaceRoot: "/home/d/web" }];
    expect(hubThreadTarget(hub("web", {}, [["Steve", "/home/d/web"]]), projects, nodes)).toEqual({
      kind: "open",
      project: projects[0],
    });
    expect(
      hubThreadTarget(
        hub("api", {}, [
          ["Bob", "/srv/api"],
          ["Ada", "/home/d/api"],
        ]),
        projects,
        nodes,
      ),
    ).toEqual({ kind: "add", environmentId: ada, nodeName: "Ada", workspaceRoot: "/home/d/api" });
    expect(hubThreadTarget(hub("api", {}, [["Bob", "/srv/api"]]), projects, nodes)).toEqual({
      kind: "unavailable",
      nodeNames: ["Bob"],
    });
  });
});

describe("pickerSections", () => {
  it("puts favourites first, then arranged projects, then the rest by name", () => {
    const rows = linkPickerRows(
      [
        group("Zed", [[steve, "/z"]]),
        group("Beta", [[steve, "/b"]]),
        group("Alpha", [[steve, "/a"]]),
        group("Star", [[steve, "/s"]]),
        group("Apex", [[steve, "/x"]]),
      ],
      [
        hub("beta", { sortIndex: 1 }, [["Steve", "/b"]]),
        hub("alpha", { sortIndex: 2 }, [["Steve", "/a"]]),
        hub("star", { favorite: true }, [["Steve", "/s"]]),
      ],
      nodes,
    );
    const { favorites, others } = pickerSections(rows);
    expect(favorites.map((row) => row.group.displayName)).toEqual(["Star"]);
    expect(others.map((row) => row.group.displayName)).toEqual(["Beta", "Alpha", "Apex", "Zed"]);
  });
});

describe("sortPickerRows", () => {
  const rows = linkPickerRows(
    [group("Zed", [[steve, "/z"]]), group("Low", [[steve, "/l"]]), group("Crit", [[steve, "/c"]])],
    [
      hub("low", { priority: "low", favorite: true }, [["Steve", "/l"]]),
      hub("crit", { priority: "critical", status: "paused" }, [["Steve", "/c"]]),
    ],
    nodes,
  );
  const activeAt = { Zed: "2026-10-03", Low: "2026-10-01", Crit: null } as Record<
    string,
    string | null
  >;
  const names = (sort: Parameters<typeof sortPickerRows>[1]) =>
    sortPickerRows(rows, sort, {
      strategy: [],
      activeAt: (g) => activeAt[g.displayName] ?? null,
    }).map((row) => row.group.displayName);

  it("keeps favourites first by default and puts projects outside the Hub last for Hub sorts", () => {
    expect(names("favorites")).toEqual(["Low", "Crit", "Zed"]);
    expect(names("priority")).toEqual(["Crit", "Low", "Zed"]);
    expect(names("status")).toEqual(["Low", "Crit", "Zed"]);
  });

  it("sorts by latest activity or name across every row", () => {
    expect(names("recent")).toEqual(["Zed", "Low", "Crit"]);
    expect(names("name")).toEqual(["Crit", "Low", "Zed"]);
  });
});

describe("rowMatches", () => {
  const [row] = linkPickerRows(
    [group("Emily OS", [[steve, "/e"]])],
    [hub("emily", { tags: ["client", "web"] }, [["Steve", "/e"]])],
    nodes,
  );
  it("matches names and tags, and requires the chosen tag", () => {
    expect(rowMatches(row!, "emi", null)).toBe(true);
    expect(rowMatches(row!, "CLI", null)).toBe(true);
    expect(rowMatches(row!, "nope", null)).toBe(false);
    expect(rowMatches(row!, "", "web")).toBe(true);
    expect(rowMatches(row!, "", "ops")).toBe(false);
  });
});

describe("pickerWriteFor", () => {
  it("creates an unlinked project on a node where it is checked out", () => {
    const [row] = linkPickerRows([group("Web", [[ada, "/w"]])], [], nodes);
    expect(pickerWriteFor(row!, { favorite: true }, nodes, steve)).toEqual({
      environmentId: ada,
      input: { name: "Web", localPath: "/w", favorite: true },
    });
  });

  it("patches a linked project through the primary node when its portfolio has it", () => {
    const [row] = linkPickerRows(
      [group("Web", [[ada, "/w"]])],
      [
        hub("web", {}, [
          ["Ada", "/w"],
          ["Steve", null],
        ]),
      ],
      nodes,
    );
    expect(pickerWriteFor(row!, { tags: ["x"] }, nodes, steve)).toEqual({
      environmentId: steve,
      input: { id: "web", tags: ["x"] },
    });
  });

  it("writes a stock T3 project through the Hub server on the same node", () => {
    const [unlinked] = linkPickerRows([group("Web", [[stockT3, "/w"]])], [], nodesWithT3);
    expect(pickerWriteFor(unlinked!, { favorite: true }, nodesWithT3, stockT3)).toEqual({
      environmentId: steve,
      input: { name: "Web", localPath: "/w", favorite: true },
    });
    const [linked] = linkPickerRows(
      [group("Web", [[stockT3, "/w"]])],
      [hub("web", {}, [["Steve", "/w"]])],
      nodesWithT3,
    );
    expect(linked!.hub?.project.id).toBe("web");
    expect(pickerWriteFor(linked!, { tags: ["x"] }, nodesWithT3, stockT3)?.environmentId).toBe(
      steve,
    );
  });

  it("returns null without a Hub on any member's node", () => {
    const [row] = linkPickerRows([group("Web", [["env-other" as EnvironmentId, "/w"]])], [], nodes);
    expect(pickerWriteFor(row!, { favorite: true }, nodes, steve)).toBeNull();
  });
});

describe("planPickerReorder", () => {
  it("writes only rows whose position changes, creating unarranged ones", () => {
    const rows = linkPickerRows(
      [group("A", [[steve, "/a"]]), group("B", [[steve, "/b"]]), group("C", [[steve, "/c"]])],
      [
        hub("a", { sortIndex: 0 }, [["Steve", "/a"]]),
        hub("b", { sortIndex: 1 }, [["Steve", "/b"]]),
      ],
      nodes,
    );
    const { others } = pickerSections(rows);
    // Move C (unarranged) above B.
    expect(planPickerReorder(others, 2, 1, nodes, steve)).toEqual(
      new Map([
        [
          steve,
          [
            { name: "C", localPath: "/c", sortIndex: 1 },
            { id: "b", sortIndex: 2 },
          ],
        ],
      ]),
    );
  });
});

describe("machine colours", () => {
  it("is stable per name and honours an override", () => {
    expect(autoMachineColor("Steve")).toBe(autoMachineColor("Steve"));
    expect(autoMachineColor("Steve")).not.toBe("gray");
    expect(machineColor("Steve", { Steve: "pink" })).toBe("pink");
  });
});

describe("parseTags", () => {
  it("splits on commas and newlines and drops blanks and repeats", () => {
    expect(parseTags(" web, client,,web\nops ")).toEqual(["web", "client", "ops"]);
  });
});

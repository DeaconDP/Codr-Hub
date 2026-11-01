import type { EnvironmentId, HubMergedProjectView, HubProject } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  autoMachineColor,
  linkPickerRows,
  machineColor,
  parseTags,
  pickerSections,
  pickerWriteFor,
  planPickerReorder,
  rowMatches,
} from "./projectPickerModel";

const steve = "env-steve" as EnvironmentId;
const ada = "env-ada" as EnvironmentId;
const nodes = new Map([
  [steve, "Steve"],
  [ada, "Ada"],
]);

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

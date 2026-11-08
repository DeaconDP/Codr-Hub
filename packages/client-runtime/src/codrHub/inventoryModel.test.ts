import type { HubCheckoutScan, HubProject } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  attentionList,
  buildInventory,
  filterInventory,
  UNSCANNED,
  type InventoryFilters,
} from "./inventoryModel.ts";

const scan = (patch: Partial<HubCheckoutScan>): HubCheckoutScan => ({
  scannedAt: "2026-11-06",
  category: "Private",
  engine: "Web",
  vcs: "github",
  remote: "https://github.com/DeaconDP/x",
  branch: "main",
  ahead: 0,
  behind: 0,
  dirty: 0,
  lastActivity: "2026-11-01",
  sizeGb: 0.1,
  flags: [],
  ...patch,
});
const host = (patch: Partial<HubProject["hosts"][string]> = {}) => ({
  path: "/w/x",
  stickyPort: null,
  launchCmd: null,
  ...patch,
});
const project = (id: string, hosts: HubProject["hosts"], archived = false) =>
  ({ id, name: id, hosts, archived }) as HubProject;

const NO_FILTERS: InventoryFilters = {
  query: "",
  node: "",
  category: "",
  lane: "",
  vcs: "",
  attentionOnly: false,
};

describe("codr-hub inventory", () => {
  const projects = [
    // One repo on two machines, plus a duplicate folder on the Mac.
    project("shared", {
      Steve: host({
        scan: scan({ dirty: 3, ahead: 2 }),
        otherCheckouts: [
          {
            path: "/w/shared copy",
            scan: scan({ flags: ["duplicate"], lastActivity: "2025-01-02" }),
          },
        ],
      }),
      EpicUnityPC: host({
        path: "D:/shared",
        scan: scan({ engine: "Unity", vcs: "none", remote: null, lastActivity: "2026-06-30" }),
      }),
    }),
    project("tool", {
      Steve: host({
        scan: scan({ category: "Archive", vcs: "git-local", remote: null, dirty: 50 }),
      }),
    }),
    project("t3-only", { Steve: host({ path: "/w/t3" }) }),
  ];
  const inventory = buildInventory({ projects, extraNodes: ["EpicUnrealPC"], today: "2026-11-08" });

  it("counts checkouts per machine and projects in the totals", () => {
    expect(inventory.totals).toMatchObject({
      projects: 2,
      notScanned: 1,
      checkouts: 4,
      remoteShare: 0.5,
      dirtyCheckouts: 2,
      unpushedCheckouts: 1,
      attentionProjects: 1,
      attentionCheckouts: 2,
    });
    expect(
      inventory.machines.map((m) => [m.node, m.checkouts, m.remote, m.local, m.none, m.unscanned]),
    ).toEqual([
      ["Steve", 3, 2, 1, 0, 1],
      ["EpicUnityPC", 1, 0, 0, 1, 0],
      ["EpicUnrealPC", 0, 0, 0, 0, 0],
    ]);
    expect(inventory.machines[0]!.categories).toEqual({
      Private: 2,
      Public: 0,
      Other: 0,
      Archive: 1,
    });
  });

  it("lists each checkout under its first reason", () => {
    expect(inventory.reasonCounts).toEqual({
      "at-risk": 0,
      duplicate: 1,
      unpushed: 1,
      uncommitted: 0,
      "no-remote": 0,
    });
    expect(attentionList(inventory.rows, "duplicate").map((row) => row.path)).toEqual([
      "/w/shared copy",
    ]);
  });

  it("builds the lane matrix and a twelve-month chart without Archive", () => {
    expect(inventory.lanes.lanes).toEqual(["Unity", "Web"]);
    expect(inventory.lanes.counts).toEqual([
      [0, 1, 0],
      [3, 0, 0],
    ]);
    const { months, counts, older } = inventory.activity;
    expect([months[0], months.at(-1)]).toEqual(["2025-12", "2026-11"]);
    expect(counts.at(-1)).toEqual([1, 0, 0]);
    expect(counts[months.indexOf("2026-06")]).toEqual([0, 1, 0]);
    expect(older).toBe(1);
  });

  it("filters, keeps unscanned rows findable and sorts empty values last", () => {
    const rows = inventory.rows;
    const names = (filters: Partial<InventoryFilters>, key: "dirty" | "name" = "name") =>
      filterInventory(rows, { ...NO_FILTERS, ...filters }, { key, direction: "desc" }).map(
        (row) => `${row.projectName}@${row.node}`,
      );
    expect(names({ vcs: UNSCANNED })).toEqual(["t3-only@Steve"]);
    expect(names({ attentionOnly: true, node: "Steve" })).toEqual(["shared@Steve", "shared@Steve"]);
    expect(names({}, "dirty")).toEqual([
      "tool@Steve",
      "shared@Steve",
      "shared@Steve",
      "shared@EpicUnityPC",
      "t3-only@Steve",
    ]);
    expect(names({ query: "MAIN", lane: "Unity" })).toEqual(["shared@EpicUnityPC"]);
  });
});

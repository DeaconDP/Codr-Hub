import { describe, expect, it } from "@effect/vitest";
import type { HubProject } from "@t3tools/contracts";

import { mapDeezProject } from "./deezImport.ts";
import { mergeScanImport, resolveScanNodes } from "./scanImport.ts";
import { formatScanTsv, parseScanTsv, type ScanRow } from "./scanTsv.ts";

const nowIso = "2026-11-07T12:00:00.000Z";
const NODES: Record<string, string> = { Steve: "Steve", Luckey: "EpicUnityPC" };
const context = { nowIso, nodeOf: (row: ScanRow) => NODES[row.nickname]! };

const row = (patch: Partial<ScanRow>): ScanRow => ({
  machine: "MacBook Pro",
  nickname: "Steve",
  category: "Private",
  lane: "Web",
  name: "Thing",
  vcs: "none",
  path: "/w/Thing",
  remote: null,
  branch: null,
  ahead: null,
  behind: null,
  dirty: null,
  lastActivity: "2026-11-01",
  sizeGb: 0.1,
  flags: [],
  scanned: "2026-11-06",
  ...patch,
});

const hub = (raw: Record<string, unknown>): HubProject =>
  mapDeezProject(raw, { nodeName: "Steve", nowIso: "2026-10-01T00:00:00.000Z" })!;

describe("codr-hub scan TSV", () => {
  it("reads columns by header name, with ahead/behind and flags", () => {
    const text =
      "\uFEFFmachine\tnickname\tcategory\tlane\tname\tvcs\tpath\tremote\tbranch\tahead_behind\tdirty\tlast_activity\tsize_gb\tflag\tscanned\r\n" +
      "Unity PC\tLuckey\tOther\tVRChat\tWorld\tgithub\tD:\\VR\\World\tgit@github.com:DeaconDP/World.git\tmain\t+2/-1\t31\t2026-10-30\t12.5\tat-risk,duplicate\t2026-11-06\r\n" +
      "Unity PC\tLuckey\tOther\tUnity\t\tnone\tD:\\x\t\t\t\t\t\t\t\t2026-11-06\r\n";
    const parsed = parseScanTsv(text);
    expect(parsed.errors).toEqual(["Line 3: needs a name, path and nickname."]);
    expect(parsed.rows[0]).toEqual({
      machine: "Unity PC",
      nickname: "Luckey",
      category: "Other",
      lane: "VRChat",
      name: "World",
      vcs: "github",
      path: "D:\\VR\\World",
      remote: "git@github.com:DeaconDP/World.git",
      branch: "main",
      ahead: 2,
      behind: 1,
      dirty: 31,
      lastActivity: "2026-10-30",
      sizeGb: 12.5,
      flags: ["at-risk", "duplicate"],
      scanned: "2026-11-06",
    });
    expect(parseScanTsv(formatScanTsv(parsed.rows)).rows).toEqual(parsed.rows);
    expect(parseScanTsv("a\tb\n1\t2\n").errors[0]).toMatch(/Not a workshop scan/);
  });
});

describe("codr-hub scan import", () => {
  it("makes one project per remote across machines, starting with the autopilot off", () => {
    const result = mergeScanImport(
      [],
      [
        row({
          name: "World",
          lane: "VRChat",
          vcs: "github",
          path: "/Users/epic/World",
          remote: "https://github.com/DeaconDP/World",
          dirty: 3,
        }),
        row({
          nickname: "Luckey",
          name: "World-old",
          lane: "VRChat",
          path: "D:\\VR\\World",
          remote: "git@github.com:deacondp/world.git",
          flags: ["at-risk"],
        }),
        row({ name: "Old", category: "Archive", path: "/w/Archive/Old" }),
      ],
      context,
    );
    expect(result).toMatchObject({ created: 2, matched: 0, hostsAdded: 3, skipped: 0 });
    const world = result.upserts.find((project) => project.id === "world")!;
    expect(world).toMatchObject({
      name: "World",
      autonomy: 0,
      archived: false,
      category: "Private",
      tags: ["vrchat"],
      repoUrl: "https://github.com/DeaconDP/World",
    });
    expect(Object.keys(world.hosts)).toEqual(["Steve", "EpicUnityPC"]);
    expect(world.hosts.EpicUnityPC).toMatchObject({
      path: "D:\\VR\\World",
      scan: { flags: ["at-risk"], engine: "VRChat", category: "Private" },
    });
    expect(world.hosts.Steve?.scan).toMatchObject({ dirty: 3, vcs: "github" });
    expect(result.upserts.find((project) => project.id === "old")).toMatchObject({
      archived: true,
      category: null,
    });
  });

  it("keeps the folder without copy flags as the checkout and the rest as other checkouts", () => {
    const remote = "https://github.com/DeaconDP/deepsec.git";
    const result = mergeScanImport(
      [],
      [
        row({
          name: "deepsec",
          path: "/w/Recovered/deepsec",
          remote,
          flags: ["copy", "duplicate"],
        }),
        row({ name: "deepsec", path: "/w/Tools/deepsec", remote, dirty: 279 }),
        row({ name: "Only copy", path: "/w/Recovered/Only copy", flags: ["copy"] }),
      ],
      context,
    );
    const deepsec = result.upserts.find((project) => project.id === "deepsec")!;
    expect(deepsec.hosts.Steve).toMatchObject({
      path: "/w/Tools/deepsec",
      scan: { dirty: 279 },
      otherCheckouts: [{ path: "/w/Recovered/deepsec", scan: { flags: ["copy", "duplicate"] } }],
    });
    // A copy with no working folder anywhere is filed away.
    expect(result.upserts.find((project) => project.id === "only-copy")?.archived).toBe(true);
  });

  it("matches by name only when the name is unique, and never merges two working folders", () => {
    const unity = hub({ name: "Miniverse" });
    const twinA = hub({ name: "Sandbox" });
    const twinB = { ...hub({ name: "Sandbox" }), id: "sandbox-2" };
    const result = mergeScanImport(
      [unity, twinA, twinB],
      [
        row({ name: "Miniverse", lane: "Unity", path: "/w/Unity/Miniverse" }),
        row({
          name: "Miniverse",
          lane: "Unity",
          path: "/w/Compat/Miniverse",
          flags: ["legacy-path"],
        }),
        row({ name: "Sandbox", path: "/w/Sandbox" }),
        row({ name: "Test", path: "/w/a/Test" }),
        row({ name: "Test", path: "/w/b/Test" }),
      ],
      context,
    );
    expect(result).toMatchObject({ created: 2, matched: 1, skipped: 1 });
    expect(result.upserts.find((project) => project.id === "miniverse")?.hosts.Steve).toMatchObject(
      {
        path: "/w/Unity/Miniverse",
        otherCheckouts: [{ path: "/w/Compat/Miniverse" }],
      },
    );
    expect(
      result.upserts
        .filter((project) => project.name === "Test")
        .map((project) => [project.id, project.hosts.Steve?.path]),
    ).toEqual([
      ["test", "/w/a/Test"],
      ["test-2", "/w/b/Test"],
    ]);
    expect(result.ambiguous).toHaveLength(2);
    expect(result.ambiguous.join("\n")).toMatch(/Sandbox: 2 Hub projects/);
  });

  it("fills only empty fields on existing projects and is a no-op when re-run", () => {
    const owned: HubProject = {
      ...hub({
        name: "Emily OS",
        localPath: "/Users/epic/Emily",
        priority: "High",
        status: "WIP",
        notes: "mine",
        category: "Client",
      }),
      favorite: true,
      autonomy: 50,
      tags: ["ios"],
    };
    const rows = [
      row({
        name: "Emily-OS",
        lane: "Apple",
        category: "Public",
        path: "/Users/epic/Emily",
        remote: "git@github.com:DeaconDP/Emily-OS.git",
        ahead: 2,
        behind: 0,
      }),
      row({
        nickname: "Luckey",
        name: "Emily-OS",
        path: "C:\\src\\Emily-OS",
        remote: "https://github.com/DeaconDP/Emily-OS",
      }),
    ];
    const first = mergeScanImport([owned], rows, context);
    expect(first).toMatchObject({ created: 0, matched: 1, updated: 1, hostsAdded: 1 });
    const next = first.upserts[0]!;
    expect(next).toMatchObject({
      name: "Emily OS",
      priority: "high",
      stage: "develop",
      notes: "mine",
      favorite: true,
      autonomy: 50,
      category: "Client",
      tags: ["ios"],
      repoUrl: "https://github.com/DeaconDP/Emily-OS",
      hosts: {
        Steve: { path: "/Users/epic/Emily", scan: { ahead: 2, behind: 0 } },
        EpicUnityPC: { path: "C:\\src\\Emily-OS" },
      },
    });
    const again = mergeScanImport([next], rows, context);
    expect(again).toMatchObject({ upserts: [], created: 0, matched: 1, hostsAdded: 0 });
    // The same folder with different case and slashes on Windows is still the same checkout.
    const windows = mergeScanImport(
      [next],
      [{ ...rows[1]!, path: "c:/SRC/Emily-OS/", remote: null, name: "Renamed" }],
      context,
    );
    expect(windows).toMatchObject({ created: 0, matched: 1 });
  });

  it("moves a checkout whose folder is gone, and ignores an older scan", () => {
    const moved = hub({ name: "Gauge", localPath: "/old/Gauge" });
    const rows = [row({ name: "Gauge", path: "/new/Gauge", scanned: "2026-11-06" })];
    const missingPaths = new Set(["Steve\0gauge"]);
    const fixed = mergeScanImport([moved], rows, { ...context, missingPaths }).upserts[0]!;
    expect(fixed.hosts.Steve).toMatchObject({
      path: "/new/Gauge",
      scan: { scannedAt: "2026-11-06" },
    });
    const older = mergeScanImport(
      [fixed],
      [{ ...rows[0]!, scanned: "2026-10-01", dirty: 9 }],
      context,
    );
    expect(older.upserts).toEqual([]);
  });

  it("maps nicknames to existing Hub machines and asks when one is unknown", () => {
    const rows = [{ nickname: "steve" }, { nickname: "Luckey" }];
    expect(resolveScanNodes([rows[0]!], { knownNodes: ["Steve", "EpicUnityPC"] })).toEqual({
      nodes: new Map([["steve", "Steve"]]),
    });
    expect(resolveScanNodes(rows, { knownNodes: ["Steve"] })).toMatchObject({
      error: expect.stringMatching(/^Luckey is not a machine in the Hub/),
    });
    expect(
      resolveScanNodes([rows[1]!], { knownNodes: ["Steve"], nodeName: "EpicUnityPC" }),
    ).toEqual({ nodes: new Map([["Luckey", "EpicUnityPC"]]) });
    expect(resolveScanNodes(rows, { knownNodes: [], nodeName: "Steve" })).toMatchObject({
      error: expect.stringMatching(/rows for steve, Luckey/),
    });
  });
});

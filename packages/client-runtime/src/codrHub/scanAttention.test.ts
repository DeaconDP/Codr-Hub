import type { HubCheckoutScan, HubProject } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { needsAttention, projectScanChips } from "./scanAttention.ts";

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

const project = (hosts: HubProject["hosts"], archived = false) =>
  ({ hosts, archived }) as HubProject;
const host = (patch: Partial<HubProject["hosts"][string]>) => ({
  path: "/w/x",
  stickyPort: null,
  launchCmd: null,
  ...patch,
});

describe("codr-hub scan attention", () => {
  it("flags at-risk, duplicates, dirt, unpushed work and code without a remote", () => {
    const risky = project({
      EpicUnityPC: host({ scan: scan({ flags: ["at-risk", "third-party"], dirty: 31 }) }),
      Steve: host({
        scan: scan({ ahead: 2 }),
        otherCheckouts: [{ path: "/w/copy", scan: scan({ flags: ["duplicate"], dirty: 99 }) }],
      }),
    });
    expect(projectScanChips(risky).map((chip) => [chip.label, chip.tone, chip.nodes])).toEqual([
      ["at-risk", "danger", ["EpicUnityPC"]],
      ["2 unpushed", "warning", ["Steve"]],
      ["31 changed", "warning", ["EpicUnityPC"]],
      ["duplicate", "warning", ["Steve"]],
      ["third-party", "muted", ["EpicUnityPC"]],
    ]);
    expect(needsAttention(risky)).toBe(true);
  });

  it("leaves engine projects, archives and tidy checkouts alone", () => {
    const local = (engine: string, category = "Private") =>
      host({ scan: scan({ engine, category, remote: null, vcs: "none" }) });
    expect(needsAttention(project({ Steve: local("Unity") }))).toBe(false);
    expect(needsAttention(project({ Steve: local("Web", "Archive") }))).toBe(false);
    expect(needsAttention(project({ Steve: local("Web") }))).toBe(true);
    expect(needsAttention(project({ Steve: host({}) }))).toBe(false);
    // An archived project shows up only when its copy is at risk.
    expect(needsAttention(project({ Steve: local("Web") }, true))).toBe(false);
    expect(
      needsAttention(project({ Steve: host({ scan: scan({ flags: ["at-risk"] }) }) }, true)),
    ).toBe(true);
  });
});

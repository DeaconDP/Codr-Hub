import { describe, expect, it } from "@effect/vitest";

import { mapDeezProject } from "./deezImport.ts";
import { mergeT3Import, planT3Creates, repoKey, type T3ProjectInput } from "./t3Import.ts";

const context = {
  nodeName: "Steve",
  nowIso: "2026-10-27T12:00:00.000Z",
  missingPathIds: new Set<string>(),
};

const hub = (raw: Record<string, unknown>) => mapDeezProject(raw, context)!;

const t3 = (title: string, workspaceRoot: string, remoteUrl?: string): T3ProjectInput => ({
  title,
  workspaceRoot,
  repositoryIdentity: remoteUrl
    ? {
        canonicalKey: remoteUrl,
        locator: { source: "git-remote", remoteName: "origin", remoteUrl },
      }
    : null,
});

describe("codr-hub T3 import", () => {
  it("normalises ssh and https remotes to one key", () => {
    expect(repoKey("git@github.com:DeaconDP/Emily-OS.git")).toBe("github.com/deacondp/emily-os");
    expect(repoKey("https://www.github.com/deacondp/emily-os/")).toBe(
      "github.com/deacondp/emily-os",
    );
    expect(repoKey(null)).toBeNull();
  });

  it("adds unknown projects with the autopilot off and skips ones already linked here", () => {
    const linked = hub({ name: "Codr-Hub", localPath: "/w/Codr-Hub" });
    const result = mergeT3Import(
      [linked],
      [t3("Codr-Hub", "/w/Codr-Hub/"), t3("Fresh", "/w/fresh", "git@github.com:me/fresh.git")],
      context,
    );
    expect(result).toMatchObject({ imported: 1, updated: 0, skipped: 1 });
    expect(result.upserts[0]).toMatchObject({
      id: "fresh",
      autonomy: 0,
      repoUrl: "git@github.com:me/fresh.git",
      hosts: { Steve: { path: "/w/fresh" } },
    });
  });

  it("links by repository first, then by name, without overwriting other nodes", () => {
    const byRepo = hub({
      name: "Emily OS",
      githubUrl: "https://github.com/DeaconDP/Emily-OS",
    });
    const byName = { ...hub({ name: "Fuel Gauge" }), hosts: { Edgar: { path: "C:/fuel" } } };
    const result = mergeT3Import(
      [byRepo, byName],
      [
        t3("emily", "/w/emily", "git@github.com:deacondp/emily-os.git"),
        t3("fuel-gauge", "/w/fuel"),
      ],
      context,
    );
    expect(result).toMatchObject({ imported: 0, updated: 2 });
    expect(result.upserts.map((project) => [project.id, project.hosts])).toEqual([
      ["emily-os", { Steve: { path: "/w/emily" } }],
      ["fuel-gauge", { Edgar: { path: "C:/fuel" }, Steve: { path: "/w/fuel" } }],
    ]);
  });

  it("replaces a missing checkout and ignores a second clone of a linked project", () => {
    const stale = hub({ name: "Emily-OS", localPath: "/old/Emily-OS" });
    const result = mergeT3Import(
      [stale],
      [t3("Emily-OS", "/w/Emily-OS"), t3("Emily-OS", "/w/Emily-OS-copy")],
      { ...context, missingPathIds: new Set(["emily-os"]) },
    );
    expect(result).toMatchObject({ imported: 0, updated: 1, skipped: 1 });
    expect(result.upserts[0]?.hosts).toEqual({ Steve: { path: "/w/Emily-OS" } });
  });

  it("plans T3 projects only for live, unlinked checkouts on this node", () => {
    const linked = hub({ name: "Linked", localPath: "/w/linked" });
    const fresh = hub({ name: "Fresh", localPath: "/w/fresh" });
    const twin = hub({ name: "Twin", localPath: "/w/fresh/" });
    const elsewhere = { ...hub({ name: "Elsewhere" }), hosts: { Edgar: { path: "/e/x" } } };
    const archived = { ...hub({ name: "Old", localPath: "/w/old" }), archived: true };
    const gone = hub({ name: "Gone", localPath: "/w/gone" });
    const plan = planT3Creates(
      [linked, fresh, twin, elsewhere, archived, gone],
      [t3("Linked", "/w/linked/")],
      { nodeName: "Steve", missingPathIds: new Set([gone.id]) },
    );
    expect(plan.map((entry) => [entry.project.id, entry.workspaceRoot])).toEqual([
      ["fresh", "/w/fresh"],
    ]);
  });

  it("converges: a planned checkout imported back from T3 is skipped", () => {
    const fresh = hub({ name: "Fresh", localPath: "/w/fresh" });
    const [created] = planT3Creates([fresh], [], context);
    const back = mergeT3Import(
      [fresh],
      [t3(created!.project.name, created!.workspaceRoot)],
      context,
    );
    expect(back).toMatchObject({ upserts: [], imported: 0, updated: 0, skipped: 1 });
    expect(planT3Creates([fresh], [t3("Fresh", "/w/fresh")], context)).toEqual([]);
  });
});

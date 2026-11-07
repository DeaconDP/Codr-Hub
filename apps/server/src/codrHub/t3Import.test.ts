import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";

import { mapDeezProject } from "./deezImport.ts";
import { mergeT3Import, planT3Creates, repoKey, type T3ProjectInput } from "./t3Import.ts";
import { pickT3Source, remoteT3Links } from "./t3Source.ts";

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
    const byName = {
      ...hub({ name: "Fuel Gauge" }),
      hosts: { Edgar: { path: "C:/fuel", stickyPort: null, launchCmd: null } },
    };
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
      ["emily-os", { Steve: { path: "/w/emily", stickyPort: null, launchCmd: null } }],
      [
        "fuel-gauge",
        {
          Edgar: { path: "C:/fuel", stickyPort: null, launchCmd: null },
          Steve: { path: "/w/fuel", stickyPort: null, launchCmd: null },
        },
      ],
    ]);
  });

  it("replaces a missing checkout and ignores a second clone of a linked project", () => {
    const stale = hub({
      name: "Emily-OS",
      localPath: "/old/Emily-OS",
      stickyPort: 5173,
      launchCmd: "npm run dev",
    });
    const result = mergeT3Import(
      [stale],
      [t3("Emily-OS", "/w/Emily-OS"), t3("Emily-OS", "/w/Emily-OS-copy")],
      { ...context, missingPathIds: new Set(["emily-os"]) },
    );
    expect(result).toMatchObject({ imported: 0, updated: 1, skipped: 1 });
    expect(result.upserts[0]?.hosts).toEqual({
      Steve: { path: "/w/Emily-OS", stickyPort: 5173, launchCmd: "npm run dev" },
    });
    // A live checkout moves to the folder T3 has open, unless T3 also has the old one open.
    expect(mergeT3Import([stale], [t3("Emily-OS", "/w/Emily-OS")], context).upserts).toEqual([
      expect.objectContaining({
        hosts: { Steve: { path: "/w/Emily-OS", stickyPort: 5173, launchCmd: "npm run dev" } },
      }),
    ]);
    expect(
      mergeT3Import(
        [stale],
        [t3("Emily-OS", "/w/Emily-OS"), t3("Emily-OS old", "/old/Emily-OS/")],
        context,
      ),
    ).toMatchObject({ upserts: [], updated: 0, skipped: 2 });
  });

  it("plans T3 projects only for live, unlinked checkouts on this node", () => {
    const linked = hub({ name: "Linked", localPath: "/w/linked" });
    const fresh = hub({ name: "Fresh", localPath: "/w/fresh" });
    const twin = hub({ name: "Twin", localPath: "/w/fresh/" });
    const elsewhere = {
      ...hub({ name: "Elsewhere" }),
      hosts: { Edgar: { path: "/e/x", stickyPort: null, launchCmd: null } },
    };
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

  it("reads the one linked T3 on this machine unless told otherwise", () => {
    const link = (id: string, url: string, status: "reachable" | "expired" = "reachable") => ({
      environmentId: EnvironmentId.make(id),
      urls: [url],
      status,
    });
    const stock = link("stock", "http://127.0.0.1:3773");
    const vps = link("vps", "https://vps.example.ts.net");
    expect(pickT3Source(undefined, [stock, vps])).toBe("stock");
    expect(pickT3Source("auto", [stock, link("other", "http://localhost:4000")])).toBeNull();
    expect(pickT3Source("auto", [link("stock", "http://127.0.0.1:3773", "expired")])).toBeNull();
    expect(pickT3Source("local", [stock])).toBeNull();
    expect(pickT3Source(EnvironmentId.make("vps"), [stock])).toBe("vps");
    const expired = link("old", "https://old.example.ts.net", "expired");
    const ids = (own: EnvironmentId | null) =>
      remoteT3Links([stock, vps, expired], own).map((entry) => entry.environmentId);
    expect(ids(EnvironmentId.make("stock"))).toEqual(["vps"]);
    expect(ids(EnvironmentId.make("vps"))).toEqual([]);
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

// @effect-diagnostics nodeBuiltinImport:off - Exercises the plain-Node scanner on a temp folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { scanDisk, scanRoots, type GitRunner } from "./diskScan.ts";

const make = (root: string, files: ReadonlyArray<string>) => {
  for (const file of files) {
    const full = NodePath.join(root, file);
    NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
    NodeFS.writeFileSync(full, file.endsWith("/.git/HEAD") ? "ref: refs/heads/main\n" : "x");
  }
};

describe("codr-hub disk scan", () => {
  it("stops at project roots, skips worktrees and build folders, flags copies", async () => {
    using _dir = {
      path: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codr-hub-scan-")),
      [Symbol.dispose]() {
        NodeFS.rmSync(this.path, { recursive: true, force: true });
      },
    };
    const workshop = NodePath.join(_dir.path, "Workshop");
    make(workshop, [
      "Private/App/.git/HEAD",
      "Private/App/package.json",
      "Private/App/packages/inner/.git/HEAD",
      "Private/Unity/World/ProjectSettings/x",
      "Private/Unity/World/Assets/x",
      "Private/Unity/World/Packages/vpm-manifest.json",
      "Private/Recovered/App/.git/HEAD",
      "Private/Notes/readme.md",
      "Private/node_modules/pkg/.git/HEAD",
      "Other/Archive/Old/file.txt",
      "Other/Compatibility/Legacy/.git/HEAD",
    ]);
    NodeFS.mkdirSync(NodePath.join(workshop, "Private", "App-wt"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(workshop, "Private", "App-wt", ".git"),
      "gitdir: /x/.git/worktrees/App-wt\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(workshop, "Private", "Unity", "World", "Packages", "vpm-manifest.json"),
      '{"dependencies":{"com.vrchat.worlds":{}}}',
    );
    const remotes: Record<string, string> = {
      App: "git@github.com:DeaconDP/App.git",
      Legacy: "https://github.com/someone/Legacy",
    };
    const git: GitRunner = async (cwd, args) => {
      const name = NodePath.basename(cwd);
      if (args[0] === "remote") return remotes[name] ?? "";
      if (args[0] === "status") return name === "App" ? " M a\n?? b" : "";
      if (args[0] === "rev-list") return "1\t0";
      if (args[0] === "log") return "2026-11-05";
      return "main";
    };
    const rows = await scanDisk({
      machine: "Mac",
      nickname: "Steve",
      roots: scanRoots({ workshop, roots: [{ path: "/does/not/exist", category: "Other" }] }),
      owners: ["DeaconDP"],
      today: "2026-11-07",
      platform: "darwin",
      sizes: false,
      git,
    });
    const byPath = new Map(rows.map((row) => [NodePath.relative(workshop, row.path), row]));
    expect([...byPath.keys()].sort()).toEqual(
      [
        "Other/Archive/Old",
        "Other/Compatibility/Legacy",
        "Private/App",
        "Private/Notes",
        "Private/Recovered/App",
        "Private/Unity/World",
      ].map((rel) => rel.split("/").join(NodePath.sep)),
    );
    expect(byPath.get(NodePath.join("Private", "App"))).toMatchObject({
      vcs: "github",
      lane: "Web",
      dirty: 2,
      ahead: 1,
      behind: 0,
      flags: [],
    });
    expect(byPath.get(NodePath.join("Private", "Recovered", "App"))?.flags).toEqual([
      "copy",
      "duplicate",
    ]);
    expect(byPath.get(NodePath.join("Private", "Unity", "World"))).toMatchObject({
      lane: "VRChat",
      vcs: "none",
    });
    expect(byPath.get(NodePath.join("Other", "Archive", "Old"))?.category).toBe("Archive");
    expect(byPath.get(NodePath.join("Other", "Compatibility", "Legacy"))?.flags).toEqual([
      "legacy-path",
      "third-party",
    ]);
  });
});

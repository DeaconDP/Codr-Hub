import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { fastForward, inspectCheckout } from "./git.ts";

const git = (cwd: string, args: readonly string[]) => {
  NodeChildProcess.execFileSync("git", args, { cwd, stdio: "ignore" });
};

const commitFile = (cwd: string, name: string, body: string) => {
  NodeFS.writeFileSync(NodePath.join(cwd, name), body);
  git(cwd, ["add", name]);
  git(cwd, ["commit", "-m", name]);
};

describe("fastForward", () => {
  it("moves a clean checkout onto a descendant commit and refuses a dirty tree", async () => {
    const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codr-hub-fleet-"));
    git(repo, ["init", "-b", "codr-hub/v0.1"]);
    git(repo, ["config", "user.email", "fleet@example.com"]);
    git(repo, ["config", "user.name", "Fleet"]);
    git(repo, ["remote", "add", "origin", repo]);
    commitFile(repo, "readme.md", "one\n");
    const first = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    git(repo, ["update-ref", "refs/remotes/origin/codr-hub/v0.1", first]);
    git(repo, ["branch", "--set-upstream-to", "origin/codr-hub/v0.1"]);

    commitFile(repo, "readme.md", "two\n");
    const second = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    git(repo, ["update-ref", "refs/remotes/origin/codr-hub/v0.1", second]);
    git(repo, ["reset", "--hard", first]);

    const behind = await inspectCheckout(repo);
    expect(behind.git).toEqual({ _tag: "Behind", behind: 1, upstreamSha: second });
    expect(await fastForward(repo, second)).toBe(true);
    const head = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    expect(head).toBe(second);

    commitFile(repo, "readme.md", "three\n");
    const third = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    git(repo, ["update-ref", "refs/remotes/origin/codr-hub/v0.1", third]);
    git(repo, ["reset", "--hard", second]);
    NodeFS.writeFileSync(NodePath.join(repo, "readme.md"), "dirty\n");
    expect((await inspectCheckout(repo)).git).toEqual({ _tag: "Dirty" });
    expect(await fastForward(repo, third)).toBe(false);
    const still = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    expect(still).toBe(second);
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { fastForward, inspectCheckout } from "./git.ts";

const git = (cwd: string, args: readonly string[]) => {
  execFileSync("git", args, { cwd, stdio: "ignore" });
};

const commitFile = (cwd: string, name: string, body: string) => {
  writeFileSync(path.join(cwd, name), body);
  git(cwd, ["add", name]);
  git(cwd, ["commit", "-m", name]);
};

describe("fastForward", () => {
  it("moves a clean checkout onto a descendant commit and refuses a dirty tree", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "codr-hub-fleet-"));
    git(repo, ["init", "-b", "codr-hub/v0.1"]);
    git(repo, ["config", "user.email", "fleet@example.com"]);
    git(repo, ["config", "user.name", "Fleet"]);
    git(repo, ["remote", "add", "origin", repo]);
    commitFile(repo, "readme.md", "one\n");
    const first = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    git(repo, ["update-ref", "refs/remotes/origin/codr-hub/v0.1", first]);
    git(repo, ["branch", "--set-upstream-to", "origin/codr-hub/v0.1"]);

    commitFile(repo, "readme.md", "two\n");
    const second = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    git(repo, ["update-ref", "refs/remotes/origin/codr-hub/v0.1", second]);
    git(repo, ["reset", "--hard", first]);

    const behind = await inspectCheckout(repo);
    expect(behind.git).toEqual({ _tag: "Behind", behind: 1, upstreamSha: second });
    expect(await fastForward(repo, second)).toBe(true);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    expect(head).toBe(second);

    commitFile(repo, "readme.md", "three\n");
    const third = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    git(repo, ["update-ref", "refs/remotes/origin/codr-hub/v0.1", third]);
    git(repo, ["reset", "--hard", second]);
    writeFileSync(path.join(repo, "readme.md"), "dirty\n");
    expect((await inspectCheckout(repo)).git).toEqual({ _tag: "Dirty" });
    expect(await fastForward(repo, third)).toBe(false);
    const still = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    expect(still).toBe(second);
  });
});

// @effect-diagnostics nodeBuiltinImport:off - Standalone checkout supervisor runs Git without the server runtime.
/**
 * Git effects for the fleet parent. Fast-forward only.
 * Lives beside the parent so the server package does not grow a shell runner.
 */
import * as NodeChildProcess from "node:child_process";

import { classifyGitStatus, type FleetGit } from "../../apps/server/src/codrHub/fleetDecide.ts";

export type CheckoutInspection = {
  readonly git: FleetGit;
  readonly headSha: string | null;
};

type GitResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

const git = (cwd: string, args: readonly string[], timeoutMs = 60_000): Promise<GitResult> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      "git",
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 2_000_000 },
      (error, stdout, stderr) => {
        const code =
          error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });

export const inspectCheckout = async (repo: string): Promise<CheckoutInspection> => {
  const inside = await git(repo, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return { git: { _tag: "NotACheckout" }, headSha: null };
  }
  const porcelain = await git(repo, ["status", "--porcelain"]);
  const head = await git(repo, ["rev-parse", "HEAD"]);
  const upstream = await git(repo, ["rev-parse", "@{u}"]);
  let ahead = 0;
  let behind = 0;
  if (upstream.code === 0) {
    const counts = await git(repo, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
    const [aheadText, behindText] = counts.stdout.trim().split(/\s+/);
    ahead = Number(aheadText) || 0;
    behind = Number(behindText) || 0;
  }
  const headSha = head.code === 0 ? head.stdout.trim() : null;
  return {
    headSha,
    git: classifyGitStatus({
      isRepo: true,
      porcelain: porcelain.stdout,
      headSha,
      upstreamSha: upstream.code === 0 ? upstream.stdout.trim() : null,
      ahead,
      behind,
    }),
  };
};

export const fetchOrigin = (repo: string): Promise<boolean> =>
  git(repo, ["fetch", "origin"], 120_000).then((result) => result.code === 0);

/** Moves HEAD only when `sha` is a fast-forward of the current branch. */
export const fastForward = (repo: string, sha: string): Promise<boolean> =>
  git(repo, ["merge", "--ff-only", sha]).then((result) => result.code === 0);

export const hashFile = (repo: string, relativePath: string): Promise<string | null> =>
  git(repo, ["hash-object", relativePath]).then((result) =>
    result.code === 0 ? result.stdout.trim() : null,
  );

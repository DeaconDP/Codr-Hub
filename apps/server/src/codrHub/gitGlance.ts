/**
 * One-line git state for a project checkout, parsed from
 * `git status --porcelain=v2 --branch`. Kept separate from T3's VCS driver so
 * upstream changes there never reach the hub.
 *
 * @module codrHub/gitGlance
 */
import type { HubGitGlance } from "@t3tools/contracts";

export const GIT_GLANCE_ARGS = ["status", "--porcelain=v2", "--branch"] as const;

export function parseGitGlance(stdout: string): HubGitGlance {
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  let hasUpstream = false;
  let dirty = false;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      branch = head === "(detached)" ? null : head;
    } else if (line.startsWith("# branch.upstream ")) {
      hasUpstream = true;
    } else if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(line);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (line.trim() !== "" && !line.startsWith("#")) {
      dirty = true;
    }
  }
  return { branch, dirty, ahead, behind, hasUpstream };
}

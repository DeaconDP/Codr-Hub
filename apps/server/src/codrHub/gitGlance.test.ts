import { describe, expect, it } from "@effect/vitest";

import { parseGitGlance } from "./gitGlance.ts";

describe("codr-hub git glance", () => {
  it("reads branch, divergence, and dirty state", () => {
    expect(
      parseGitGlance(
        [
          "# branch.oid 7812230572",
          "# branch.head main",
          "# branch.upstream origin/main",
          "# branch.ab +2 -3",
          "1 .M N... 100644 100644 100644 abc abc src/a.ts",
          "",
        ].join("\n"),
      ),
    ).toEqual({ branch: "main", dirty: true, ahead: 2, behind: 3, hasUpstream: true });
  });

  it("handles a clean detached checkout without an upstream", () => {
    expect(parseGitGlance("# branch.oid abc\n# branch.head (detached)\n")).toEqual({
      branch: null,
      dirty: false,
      ahead: 0,
      behind: 0,
      hasUpstream: false,
    });
  });
});

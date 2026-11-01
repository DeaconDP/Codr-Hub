import { describe, expect, it } from "vite-plus/test";

import { rankProjects } from "./codrProjectPrefs";

describe("rankProjects", () => {
  it("puts favorites first, then priority, keeping the incoming order for ties", () => {
    const projects = ["a", "b", "c", "d", "e"].map((projectKey) => ({ projectKey }));
    const ranked = rankProjects(projects, ["d", "e"], { b: "low", c: "high", e: "high" });
    expect(ranked.map((project) => project.projectKey)).toEqual(["e", "d", "c", "a", "b"]);
  });
});

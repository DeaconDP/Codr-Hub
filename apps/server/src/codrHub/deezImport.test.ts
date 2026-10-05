import { describe, expect, it } from "@effect/vitest";

import {
  mapDeezProject,
  mergeDeezImport,
  readDeezProjects,
  slugifyProjectName,
} from "./deezImport.ts";

const context = { nodeName: "Steve", nowIso: "2026-10-05T12:00:00.000Z" };

const emily = {
  id: "e4113586-1e0f-4539-ac8a-4cfa68668e62",
  name: "Emily-OS",
  sortIndex: 0,
  priority: "Med",
  platform: "Web",
  status: "Testing",
  category: "Bot",
  localPath: "/Users/epic/Desktop/Projects/Cursor/Emily-OS",
  githubUrl: "https://github.com/DeaconDP/Emily-OS.git",
  githubRepo: "DeaconDP/Emily-OS",
  favorite: true,
  archived: false,
  notes: "",
  updatedAt: "2026-09-17T15:53:58.196Z",
};

describe("codr-hub Deez-PM import", () => {
  it("reads the current object file shape and a bare array", () => {
    expect(readDeezProjects({ version: 1, projects: [emily], tasks: [] })).toHaveLength(1);
    expect(readDeezProjects([emily, null, 3])).toHaveLength(1);
    expect(readDeezProjects("nope")).toHaveLength(0);
  });

  it("maps fields and starts with the autopilot off", () => {
    const project = mapDeezProject(emily, context)!;
    expect(project).toMatchObject({
      id: "emily-os",
      priority: "medium",
      status: "active",
      stage: "test",
      category: "Bot",
      tags: ["Web"],
      repoUrl: "https://github.com/DeaconDP/Emily-OS.git",
      hosts: { Steve: { path: "/Users/epic/Desktop/Projects/Cursor/Emily-OS" } },
      autonomy: 0,
      favorite: true,
    });
  });

  it("archives Deez-PM's Delete status and tolerates unknown values", () => {
    expect(mapDeezProject({ name: "Old", status: "Delete" }, context)).toMatchObject({
      archived: true,
      status: "paused",
    });
    expect(mapDeezProject({ name: "Odd", status: "???", priority: 7 }, context)).toMatchObject({
      status: "active",
      priority: "none",
      hosts: {},
    });
    expect(mapDeezProject({ status: "WIP" }, context)).toBeNull();
  });

  it("re-import fills gaps without overwriting the owner's edits", () => {
    const first = mergeDeezImport([], [emily], context);
    expect(first).toMatchObject({ imported: 1, updated: 0, skipped: 0 });

    const edited = {
      ...first.upserts[0]!,
      priority: "critical" as const,
      hosts: {},
      repoUrl: null,
    };
    const second = mergeDeezImport([edited], [emily], context);
    expect(second).toMatchObject({ imported: 0, updated: 1, skipped: 0 });
    expect(second.upserts[0]).toMatchObject({
      priority: "critical",
      hosts: { Steve: { path: emily.localPath } },
      repoUrl: emily.githubUrl,
    });

    const third = mergeDeezImport([second.upserts[0]!], [emily], context);
    expect(third).toMatchObject({ imported: 0, updated: 0, skipped: 1 });
  });

  it("slugifies names into stable file-safe ids", () => {
    expect(slugifyProjectName("Deez Fuel-Gauge (v2)")).toBe("deez-fuel-gauge-v2");
    expect(slugifyProjectName("!!!")).toBe("project");
  });
});

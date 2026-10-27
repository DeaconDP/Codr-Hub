import { describe, expect, it } from "@effect/vitest";

import {
  deezUuidToHubSlug,
  mapDeezProject,
  mergeDeezImport,
  mergeDeezTasks,
  readDeezProjects,
  readDeezTasks,
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

  it("reads tasks and maps Deez UUID project ids onto Hub slugs", () => {
    const file = {
      version: 1,
      projects: [emily],
      tasks: [
        {
          id: "card-1",
          projectId: emily.id,
          title: "Ship board",
          description: "Body",
          column: "Doing",
          priority: "High",
          sortIndex: 0,
          comments: [{ id: "c1", body: "note", createdAt: context.nowIso }],
          createdAt: context.nowIso,
          updatedAt: context.nowIso,
        },
        {
          id: "card-2",
          projectId: "missing-uuid",
          title: "Orphan",
          description: "",
          column: "Backlog",
          priority: "Low",
          sortIndex: 0,
          comments: [],
          createdAt: context.nowIso,
          updatedAt: context.nowIso,
        },
      ],
    };
    expect(readDeezTasks(file)).toHaveLength(2);
    expect(readDeezTasks([emily])).toHaveLength(0);
    const uuidMap = deezUuidToHubSlug(readDeezProjects(file));
    expect(uuidMap.get(emily.id)).toBe("emily-os");

    const first = mergeDeezTasks([], readDeezTasks(file), uuidMap);
    expect(first).toMatchObject({ imported: 1, skipped: 1 });
    expect(first.upserts[0]).toMatchObject({
      id: "card-1",
      projectId: "emily-os",
      column: "in_progress",
      priority: "high",
      deezCardId: "card-1",
      description: "Body\n\nnote",
    });

    const second = mergeDeezTasks(first.upserts, readDeezTasks(file), uuidMap);
    expect(second).toMatchObject({ imported: 0, skipped: 2 });
  });
});

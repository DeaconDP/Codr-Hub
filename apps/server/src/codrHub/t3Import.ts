/**
 * Keeps this node's T3 projects and the portfolio in step. Pure.
 *
 * `mergeT3Import` brings T3 projects into the portfolio: a T3 project already
 * checked out on this node is left alone. One that matches a portfolio project
 * by repository, then by name, fills that project's checkout here when it has
 * none or its path is missing. Anything else is added with the autopilot off.
 * Owner edits are never overwritten.
 *
 * `planT3Creates` is the reverse direction used by Sync with T3: portfolio
 * checkouts on this node that T3 has no project for. Nothing is ever deleted
 * on either side.
 *
 * @module codrHub/t3Import
 */
import type { HubProject, OrchestrationProjectShell } from "@t3tools/contracts";

import { mapDeezProject, slugifyProjectName, type DeezMergeResult } from "./deezImport.ts";

export type T3ProjectInput = Pick<
  OrchestrationProjectShell,
  "title" | "workspaceRoot" | "repositoryIdentity"
>;

const pathKey = (path: string) => path.replace(/[\\/]+$/, "");

/** `git@github.com:Owner/Repo.git` and `https://github.com/owner/repo` give the same key. */
export const repoKey = (url: string | null | undefined) => {
  if (!url) return null;
  const key = url
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):/, "$1/")
    .replace(/^www\./, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  return key === "" ? null : key;
};

const t3RepoUrl = (project: T3ProjectInput) =>
  project.repositoryIdentity?.webUrl ?? project.repositoryIdentity?.locator.remoteUrl ?? null;

export function mergeT3Import(
  existing: ReadonlyArray<HubProject>,
  t3Projects: ReadonlyArray<T3ProjectInput>,
  context: {
    readonly nodeName: string;
    readonly nowIso: string;
    /** Portfolio project ids whose checkout on this node no longer exists. */
    readonly missingPathIds: ReadonlySet<string>;
  },
): DeezMergeResult {
  const byId = new Map(existing.map((project) => [project.id, project]));
  const upserts = new Map<string, HubProject>();
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  const usableHere = (project: HubProject) =>
    project.hosts[context.nodeName] !== undefined && !context.missingPathIds.has(project.id);
  // The stored path itself counts even when missing: T3 and the Hub agree on it.
  const linkedPaths = new Set(
    existing.flatMap((project) => {
      const host = project.hosts[context.nodeName];
      return host === undefined ? [] : [pathKey(host.path)];
    }),
  );

  for (const t3 of t3Projects) {
    const path = pathKey(t3.workspaceRoot);
    if (linkedPaths.has(path)) {
      skipped += 1;
      continue;
    }
    const repoUrl = t3RepoUrl(t3);
    const repo = repoKey(repoUrl);
    const slug = slugifyProjectName(t3.title);
    const projects = [...byId.values()];
    const match =
      (repo === null ? undefined : projects.find((project) => repoKey(project.repoUrl) === repo)) ??
      projects.find((project) => project.id === slug || slugifyProjectName(project.name) === slug);
    linkedPaths.add(path);
    if (match === undefined) {
      const created = mapDeezProject(
        { name: t3.title, localPath: t3.workspaceRoot, githubUrl: repoUrl },
        context,
      )!;
      let id = created.id;
      for (let n = 2; byId.has(id); n += 1) id = `${created.id}-${n}`;
      const next: HubProject = { ...created, id, sortIndex: byId.size };
      byId.set(id, next);
      upserts.set(id, next);
      imported += 1;
      continue;
    }
    // A second checkout of a project that already has one here is not a new project.
    if (usableHere(match) || upserts.has(match.id)) {
      skipped += 1;
      continue;
    }
    const next: HubProject = {
      ...match,
      hosts: { ...match.hosts, [context.nodeName]: { path: t3.workspaceRoot } },
      repoUrl: match.repoUrl ?? repoUrl,
      updatedAt: context.nowIso,
    };
    byId.set(next.id, next);
    upserts.set(next.id, next);
    updated += 1;
  }
  return { upserts: [...upserts.values()], imported, updated, skipped };
}

/**
 * Portfolio checkouts on this node with no T3 project at that path. Archived
 * projects and checkouts whose path is missing are left out.
 */
export function planT3Creates(
  projects: ReadonlyArray<HubProject>,
  t3Projects: ReadonlyArray<Pick<T3ProjectInput, "workspaceRoot">>,
  context: {
    readonly nodeName: string;
    readonly missingPathIds: ReadonlySet<string>;
  },
): ReadonlyArray<{ readonly project: HubProject; readonly workspaceRoot: string }> {
  const known = new Set(t3Projects.map((project) => pathKey(project.workspaceRoot)));
  return projects.flatMap((project) => {
    const host = project.hosts[context.nodeName];
    if (host === undefined || project.archived || context.missingPathIds.has(project.id)) {
      return [];
    }
    const path = pathKey(host.path);
    if (known.has(path)) return [];
    known.add(path);
    return [{ project, workspaceRoot: host.path }];
  });
}

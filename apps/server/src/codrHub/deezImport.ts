/**
 * Maps Deez-Project-Manager's `projects.json` onto hub projects and tasks, reading every field
 * defensively. Re-importing only adds missing projects and cards and fills this node's path and
 * repo URL; it never overwrites hub edits.
 */
import type {
  HubPriority,
  HubProject,
  HubProjectStatus,
  HubSdlcStage,
  HubTask,
  HubTaskRank,
} from "@t3tools/contracts";

import { hubTaskFromDeez, mapDeezColumn, mintRank, type DeezTaskInput } from "./board.ts";

const PRIORITY: Record<string, HubPriority> = {
  Default: "none",
  Low: "low",
  Med: "medium",
  High: "high",
  Crit: "critical",
};

const STATUS: Record<string, { status: HubProjectStatus; stage: HubSdlcStage }> = {
  Urgent: { status: "active", stage: "develop" },
  Experiment: { status: "idea", stage: "plan" },
  "To Do": { status: "active", stage: "plan" },
  WIP: { status: "active", stage: "develop" },
  Testing: { status: "active", stage: "test" },
  Maintaining: { status: "active", stage: "maintain" },
  Done: { status: "done", stage: "maintain" },
  Broken: { status: "blocked", stage: "develop" },
  Delete: { status: "paused", stage: "maintain" },
};

export const slugifyProjectName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "project";

const str = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/** Reads the project list from a parsed Deez-PM file (current object form or a bare array). */
export function readDeezProjects(json: unknown): ReadonlyArray<Record<string, unknown>> {
  const list = Array.isArray(json)
    ? json
    : json !== null &&
        typeof json === "object" &&
        Array.isArray((json as { projects?: unknown }).projects)
      ? (json as { projects: unknown[] }).projects
      : [];
  return list.filter(
    (item): item is Record<string, unknown> => item !== null && typeof item === "object",
  );
}

export function mapDeezProject(
  raw: Record<string, unknown>,
  context: { readonly nodeName: string; readonly nowIso: string },
): HubProject | null {
  const name = str(raw.name);
  if (!name) return null;
  const mapped = STATUS[str(raw.status) ?? ""] ?? { status: "active", stage: "plan" };
  const platform = str(raw.platform);
  const githubRepo = str(raw.githubRepo);
  const localPath = str(raw.localPath);
  const updatedAt = str(raw.updatedAt) ?? context.nowIso;
  return {
    id: slugifyProjectName(name),
    name,
    priority: PRIORITY[str(raw.priority) ?? ""] ?? "none",
    status: mapped.status,
    stage: mapped.stage,
    strategyId: null,
    category: str(raw.category),
    tags: platform && platform !== "Other" ? [platform] : [],
    repoUrl: str(raw.githubUrl) ?? (githubRepo ? `https://github.com/${githubRepo}` : null),
    notes: typeof raw.notes === "string" ? raw.notes : "",
    hosts: localPath ? { [context.nodeName]: { path: localPath } } : {},
    // Imported projects start with the autopilot off; the owner opts each one in.
    autonomy: 0,
    reviewBudget: 2,
    sortIndex: typeof raw.sortIndex === "number" ? raw.sortIndex : 0,
    favorite: raw.favorite === true,
    archived: raw.archived === true || str(raw.status) === "Delete",
    lane: null,
    jobKind: "dev",
    createdAt: updatedAt,
    updatedAt,
  };
}

export interface DeezMergeResult {
  readonly upserts: ReadonlyArray<HubProject>;
  readonly imported: number;
  readonly updated: number;
  readonly skipped: number;
}

export function mergeDeezImport(
  existing: ReadonlyArray<HubProject>,
  rawProjects: ReadonlyArray<Record<string, unknown>>,
  context: { readonly nodeName: string; readonly nowIso: string },
): DeezMergeResult {
  const byId = new Map(existing.map((project) => [project.id, project]));
  const upserts: HubProject[] = [];
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  for (const raw of rawProjects) {
    const incoming = mapDeezProject(raw, context);
    if (!incoming) {
      skipped += 1;
      continue;
    }
    const current = byId.get(incoming.id);
    if (!current) {
      byId.set(incoming.id, incoming);
      upserts.push(incoming);
      imported += 1;
      continue;
    }
    const incomingHost = incoming.hosts[context.nodeName];
    const fillHost = incomingHost !== undefined && current.hosts[context.nodeName] === undefined;
    const fillRepo = current.repoUrl === null && incoming.repoUrl !== null;
    if (!fillHost && !fillRepo) {
      skipped += 1;
      continue;
    }
    const next: HubProject = {
      ...current,
      hosts: fillHost ? { ...current.hosts, [context.nodeName]: incomingHost } : current.hosts,
      repoUrl: fillRepo ? incoming.repoUrl : current.repoUrl,
      updatedAt: context.nowIso,
    };
    byId.set(next.id, next);
    upserts.push(next);
    updated += 1;
  }
  return { upserts, imported, updated, skipped };
}

/** Deez UUID project id → Hub slug (from project name). */
export function deezUuidToHubSlug(
  rawProjects: ReadonlyArray<Record<string, unknown>>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of rawProjects) {
    const id = str(raw.id);
    const name = str(raw.name);
    if (id === null || name === null) continue;
    map.set(id, slugifyProjectName(name));
  }
  return map;
}

/** Reads the task list from a parsed Deez-PM file (object form only). */
export function readDeezTasks(json: unknown): ReadonlyArray<Record<string, unknown>> {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return [];
  const list = (json as { tasks?: unknown }).tasks;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (item): item is Record<string, unknown> => item !== null && typeof item === "object",
  );
}

const commentsFrom = (value: unknown): ReadonlyArray<{ readonly body: string }> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const comments: { body: string }[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const body = str((entry as { body?: unknown }).body);
    if (body !== null) comments.push({ body });
  }
  return comments;
};

const FALLBACK_ISO = "1970-01-01T00:00:00.000Z";

const parseDeezTask = (
  raw: Record<string, unknown>,
):
  | (DeezTaskInput & {
      readonly deezProjectId: string;
      readonly sortIndex: number;
    })
  | null => {
  const id = str(raw.id);
  const deezProjectId = str(raw.projectId);
  const title = str(raw.title);
  if (id === null || deezProjectId === null || title === null) return null;
  const comments = commentsFrom(raw.comments);
  return {
    id,
    deezProjectId,
    title,
    description: typeof raw.description === "string" ? raw.description : "",
    column: str(raw.column) ?? "Backlog",
    priority: str(raw.priority) ?? "Default",
    ...(comments !== undefined ? { comments } : {}),
    sortIndex: typeof raw.sortIndex === "number" ? raw.sortIndex : 0,
    createdAt: str(raw.createdAt) ?? FALLBACK_ISO,
    updatedAt: str(raw.updatedAt) ?? FALLBACK_ISO,
  };
};

export interface DeezTaskMergeResult {
  readonly upserts: ReadonlyArray<HubTask>;
  readonly imported: number;
  readonly skipped: number;
}

/**
 * Additive task import: UUID project ids map to Hub slugs; existing deezCardId
 * values are skipped. Ranks append within each Hub column so order follows Deez
 * sortIndex among newly imported cards.
 */
export function mergeDeezTasks(
  existing: ReadonlyArray<HubTask>,
  rawTasks: ReadonlyArray<Record<string, unknown>>,
  uuidToSlug: ReadonlyMap<string, string>,
): DeezTaskMergeResult {
  const knownDeez = new Set(
    existing.map((task) => task.deezCardId).filter((id): id is string => id !== null),
  );
  const byId = new Map(existing.map((task) => [task.id, task]));
  // Last rank per project+column among cards we will keep (existing + new).
  const lastRank = new Map<string, HubTaskRank>();
  for (const task of existing) {
    const key = `${task.projectId}\0${task.column}`;
    const prev = lastRank.get(key);
    if (prev === undefined || task.rank > prev) lastRank.set(key, task.rank);
  }

  const parsed = rawTasks
    .map(parseDeezTask)
    .filter((task): task is NonNullable<typeof task> => task !== null)
    .sort((a, b) => a.sortIndex - b.sortIndex || a.id.localeCompare(b.id));

  const upserts: HubTask[] = [];
  let imported = 0;
  let skipped = 0;
  for (const deez of parsed) {
    if (knownDeez.has(deez.id) || byId.has(deez.id)) {
      skipped += 1;
      continue;
    }
    const hubProjectId = uuidToSlug.get(deez.deezProjectId);
    if (hubProjectId === undefined) {
      skipped += 1;
      continue;
    }
    const column = mapDeezColumn(deez.column);
    const key = `${hubProjectId}\0${column}`;
    const rank = mintRank(lastRank.get(key) ?? null, null);
    const hub = hubTaskFromDeez(deez, hubProjectId, rank);
    lastRank.set(key, hub.rank);
    byId.set(hub.id, hub);
    knownDeez.add(deez.id);
    upserts.push(hub);
    imported += 1;
  }
  return { upserts, imported, skipped };
}

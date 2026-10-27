/**
 * Maps Deez-Project-Manager's `projects.json` onto hub projects. Pure and
 * tolerant: Deez-PM's file has grown fields over time, so every field is
 * read defensively and unknown values fall back to safe defaults.
 *
 * Re-importing never overwrites what the owner has edited in the hub; it only
 * adds missing projects and fills null shared fleet slots plus this node's
 * checkout path / sticky port / launch command and repo URL.
 *
 * @module codrHub/deezImport
 */
import type {
  HubPriority,
  HubProject,
  HubProjectHost,
  HubProjectStatus,
  HubSdlcStage,
} from "@t3tools/contracts";

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

const intOrNull = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

const absent = (value: string | null | undefined) =>
  value === null || value === undefined || value === "";

const fillString = (current: string | null, incoming: string | null) =>
  absent(current) && incoming !== null ? incoming : current;

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

function mapDeezHost(raw: Record<string, unknown>): HubProjectHost | null {
  const path = str(raw.localPath);
  if (!path) return null;
  return {
    path,
    stickyPort: intOrNull(raw.stickyPort),
    launchCmd: str(raw.launchCmd),
  };
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
  const host = mapDeezHost(raw);
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
    previewUrl: str(raw.previewUrl),
    liveUrl: str(raw.liveUrl),
    siteId: str(raw.siteId),
    // Product face from Deez; not T3 clientSurface. Deez `host` is ignored as a stored field.
    surface: str(raw.surface),
    notes: typeof raw.notes === "string" ? raw.notes : "",
    hosts: host ? { [context.nodeName]: host } : {},
    // Imported projects start with the autopilot off; the owner opts each one in.
    autonomy: 0,
    reviewBudget: 2,
    sortIndex: typeof raw.sortIndex === "number" ? raw.sortIndex : 0,
    favorite: raw.favorite === true,
    archived: raw.archived === true || str(raw.status) === "Delete",
    createdAt: updatedAt,
    updatedAt,
  };
}

function mergeHostFill(
  current: HubProjectHost | undefined,
  incoming: HubProjectHost | undefined,
): { readonly hostsChanged: boolean; readonly host: HubProjectHost | undefined } {
  if (incoming === undefined) return { hostsChanged: false, host: current };
  if (current === undefined) return { hostsChanged: true, host: incoming };
  const stickyPort = current.stickyPort === null ? incoming.stickyPort : current.stickyPort;
  const launchCmd = absent(current.launchCmd) ? incoming.launchCmd : current.launchCmd;
  if (stickyPort === current.stickyPort && launchCmd === current.launchCmd) {
    return { hostsChanged: false, host: current };
  }
  return {
    hostsChanged: true,
    host: { path: current.path, stickyPort, launchCmd },
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
    const { hostsChanged, host } = mergeHostFill(current.hosts[context.nodeName], incomingHost);
    const previewUrl = fillString(current.previewUrl, incoming.previewUrl);
    const liveUrl = fillString(current.liveUrl, incoming.liveUrl);
    const siteId = fillString(current.siteId, incoming.siteId);
    const surface = fillString(current.surface, incoming.surface);
    const repoUrl = fillString(current.repoUrl, incoming.repoUrl);
    const sharedChanged =
      previewUrl !== current.previewUrl ||
      liveUrl !== current.liveUrl ||
      siteId !== current.siteId ||
      surface !== current.surface ||
      repoUrl !== current.repoUrl;
    if (!hostsChanged && !sharedChanged) {
      skipped += 1;
      continue;
    }
    const next: HubProject = {
      ...current,
      hosts:
        hostsChanged && host !== undefined
          ? { ...current.hosts, [context.nodeName]: host }
          : current.hosts,
      previewUrl,
      liveUrl,
      siteId,
      surface,
      repoUrl,
      updatedAt: context.nowIso,
    };
    byId.set(next.id, next);
    upserts.push(next);
    updated += 1;
  }
  return { upserts, imported, updated, skipped };
}

/**
 * Upserts Hub projects from disk-scan rows: one project per git remote, or per name when a folder
 * has no remote and the name is unambiguous. Each machine keeps one checkout plus `otherCheckouts`.
 * Existing projects only get empty fields filled; owner fields are never overwritten.
 */
import type {
  HubCheckoutScan,
  HubOtherCheckout,
  HubProject,
  HubProjectHost,
} from "@t3tools/contracts";

import { slugifyProjectName } from "./deezImport.ts";
import type { ScanRow } from "./scanTsv.ts";
import { repoKey } from "./t3Import.ts";

/** Flags that mark a folder as a second copy rather than the project's working checkout. */
const SECONDARY_FLAGS = new Set(["copy", "duplicate", "backup", "half-copy", "legacy-path"]);
/** Flags that make a folder not count as a live copy when deciding to archive a new project. */
const DEAD_FLAGS = new Set(["copy", "backup"]);

export interface ScanMergeResult {
  readonly upserts: ReadonlyArray<HubProject>;
  readonly rows: number;
  readonly created: number;
  readonly matched: number;
  readonly updated: number;
  readonly hostsAdded: number;
  readonly skipped: number;
  readonly ambiguous: ReadonlyArray<string>;
}

/**
 * Maps each nickname in the file to a Hub machine name. An explicit `nodeName` covers a
 * single-machine file; otherwise a nickname must already name a Hub machine (any case).
 */
export function resolveScanNodes(
  rows: ReadonlyArray<Pick<ScanRow, "nickname">>,
  context: { readonly nodeName?: string | undefined; readonly knownNodes: ReadonlyArray<string> },
): { readonly nodes: ReadonlyMap<string, string> } | { readonly error: string } {
  const nicknames = [...new Set(rows.map((row) => row.nickname))];
  if (context.nodeName !== undefined) {
    if (nicknames.length > 1) {
      return {
        error: `This file has rows for ${nicknames.join(", ")}. Leave the machine on "From file" to import each under its own name.`,
      };
    }
    return { nodes: new Map(nicknames.map((nickname) => [nickname, context.nodeName!])) };
  }
  const nodes = new Map<string, string>();
  const unknown: string[] = [];
  for (const nickname of nicknames) {
    const known = context.knownNodes.find((node) => node.toLowerCase() === nickname.toLowerCase());
    if (known === undefined) unknown.push(nickname);
    else nodes.set(nickname, known);
  }
  if (unknown.length > 0) {
    return {
      error: `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a machine in the Hub (it has ${context.knownNodes.join(", ") || "none yet"}). Choose which machine the scan is from.`,
    };
  }
  return { nodes };
}

/** Windows paths compare case-insensitively; trailing separators never count. */
const pathKey = (path: string) => {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  return /^[a-z]:[\\/]|^\\\\/i.test(trimmed)
    ? trimmed.replaceAll("/", "\\").toLowerCase()
    : trimmed;
};

const isSecondary = (row: ScanRow) => row.flags.some((flag) => SECONDARY_FLAGS.has(flag));

/** Working checkout first: not a copy, not archived, most recent activity, then path. */
const byPreference = (a: ScanRow, b: ScanRow) =>
  Number(isSecondary(a)) - Number(isSecondary(b)) ||
  Number(a.category === "Archive") - Number(b.category === "Archive") ||
  (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "") ||
  a.path.localeCompare(b.path);

const scanFacts = (row: ScanRow): HubCheckoutScan => ({
  scannedAt: row.scanned,
  category: row.category,
  engine: row.lane,
  vcs: row.vcs,
  remote: row.remote,
  branch: row.branch,
  ahead: row.ahead,
  behind: row.behind,
  dirty: row.dirty,
  lastActivity: row.lastActivity,
  sizeGb: row.sizeGb,
  flags: row.flags,
});

/** `git@github.com:Owner/Repo.git` → `https://github.com/Owner/Repo`; other remotes as written. */
const repoUrlOf = (remote: string) => {
  const key = repoKey(remote);
  if (key?.startsWith("github.com/")) {
    const original = /github\.com[:/]+(.+?)(?:\.git)?\/*$/i.exec(remote.trim());
    return `https://github.com/${original?.[1] ?? key.slice("github.com/".length)}`;
  }
  return remote.trim();
};

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : inner,
  );

interface Unit {
  /** Rows by Hub machine; the first row of each list is that machine's preferred checkout. */
  readonly byNode: ReadonlyMap<string, ReadonlyArray<ScanRow>>;
  readonly remote: string | null;
  /** Only match an existing project by path (an ambiguous name). */
  readonly pathOnly: boolean;
}

export function mergeScanImport(
  existing: ReadonlyArray<HubProject>,
  rows: ReadonlyArray<ScanRow>,
  context: {
    readonly nowIso: string;
    readonly nodeOf: (row: ScanRow) => string;
    /** Existing project ids whose checkout on that node no longer exists, keyed `${node}\0${id}`. */
    readonly missingPaths?: ReadonlySet<string>;
    /** Symlink-resolved paths, keyed `${node}\0${path}`, so a linked folder is the same checkout. */
    readonly realPaths?: ReadonlyMap<string, string>;
  },
): ScanMergeResult {
  const byId = new Map(existing.map((project) => [project.id, project]));
  const existingIds = new Set(byId.keys());
  const upserts = new Map<string, HubProject>();
  const ambiguous: string[] = [];
  let created = 0;
  let matched = 0;
  let hostsAdded = 0;
  let skipped = 0;
  const touchedHosts = new Set<string>();
  const keyOf = (node: string, path: string) =>
    pathKey(context.realPaths?.get(`${node}\0${path}`) ?? path);

  // Group rows: by remote, else by name.
  const groups = new Map<string, ScanRow[]>();
  for (const row of rows) {
    const repo = repoKey(row.remote);
    const key = repo !== null ? `repo:${repo}` : `name:${slugifyProjectName(row.name)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const units: Unit[] = [];
  const toUnit = (group: ReadonlyArray<ScanRow>, pathOnly: boolean): Unit => {
    const byNode = new Map<string, ScanRow[]>();
    for (const row of group) {
      const node = context.nodeOf(row);
      byNode.set(node, [...(byNode.get(node) ?? []), row]);
    }
    for (const list of byNode.values()) list.sort(byPreference);
    return { byNode, remote: group.find((row) => row.remote !== null)?.remote ?? null, pathOnly };
  };
  for (const [key, group] of groups) {
    if (key.startsWith("repo:")) {
      units.push(toUnit(group, false));
      continue;
    }
    // Two working folders with the same name on one machine may be different projects.
    const clash = [...toUnit(group, false).byNode].find(
      ([, list]) => list.filter((row) => !isSecondary(row)).length > 1,
    );
    if (clash === undefined) {
      units.push(toUnit(group, false));
      continue;
    }
    ambiguous.push(
      `${group[0]!.name}: several folders on ${clash[0]} share this name and have no git remote, so each is its own project (${clash[1].map((row) => row.path).join("; ")}).`,
    );
    for (const row of group) units.push(toUnit([row], true));
  }

  const byPath = (unit: Unit): HubProject | undefined => {
    const projects = [...byId.values()];
    for (const [node, list] of unit.byNode) {
      const keys = new Set(list.map((row) => keyOf(node, row.path)));
      const hit = projects.find((project) => {
        const host = project.hosts[node];
        return (
          host !== undefined &&
          (keys.has(keyOf(node, host.path)) ||
            (host.otherCheckouts ?? []).some((other) => keys.has(keyOf(node, other.path))))
        );
      });
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  /** A repo URL that the project's own scanned checkouts disagree with can't be trusted. */
  const contradicted = (project: HubProject) =>
    Object.values(project.hosts).some(
      (host) => host.scan?.remote != null && repoKey(host.scan.remote) !== repoKey(project.repoUrl),
    );

  const findExisting = (unit: Unit): HubProject | undefined | "ambiguous" => {
    const projects = [...byId.values()];
    const repo = repoKey(unit.remote);
    const hit = byPath(unit);
    if (hit !== undefined) {
      if (repo !== null && hit.repoUrl !== null && repoKey(hit.repoUrl) !== repo) {
        ambiguous.push(
          `${hit.name}: its repo URL is ${hit.repoUrl} but the folder's remote is ${unit.remote}. Check the repo URL.`,
        );
      }
      return hit;
    }
    if (unit.pathOnly) return undefined;
    if (repo !== null) {
      const sameRepo = projects
        .filter((project) => repoKey(project.repoUrl) === repo && !contradicted(project))
        .sort((a, b) => a.sortIndex - b.sortIndex);
      if (sameRepo.length > 1) {
        ambiguous.push(
          `${sameRepo.map((project) => project.name).join(", ")} share the remote ${unit.remote}; the scan was added to ${sameRepo[0]!.name}.`,
        );
      }
      if (sameRepo[0] !== undefined) return sameRepo[0];
    }
    // By name: only a project with no remote, or (for a folder without one) any project.
    const first = [...unit.byNode.values()][0]![0]!;
    const slug = slugifyProjectName(first.name);
    const sameName = projects.filter(
      (project) =>
        (project.id === slug || slugifyProjectName(project.name) === slug) &&
        (repo === null || project.repoUrl === null),
    );
    if (sameName.length > 1) {
      ambiguous.push(
        `${first.name}: ${sameName.length} Hub projects have this name; its ${[...unit.byNode.values()].flat().length} folder(s) were skipped. Set the checkout by hand.`,
      );
      return "ambiguous";
    }
    return sameName[0];
  };

  const hostFor = (
    node: string,
    list: ReadonlyArray<ScanRow>,
    current: HubProjectHost | undefined,
    projectId: string | null,
  ): HubProjectHost => {
    // Keep the owner's checkout path unless it no longer exists; scan facts follow the path.
    const missing =
      projectId !== null && context.missingPaths?.has(`${node}\0${projectId}`) === true;
    const keep = current !== undefined && !missing;
    const path = keep ? current.path : list[0]!.path;
    const here = list.find((row) => keyOf(node, row.path) === keyOf(node, path));
    const fresh = list
      .filter((row) => row !== here)
      .map((row) => ({ path: row.path, scan: scanFacts(row) }));
    // A second group of rows landing on the same checkout this run adds to the first.
    const touched = projectId !== null && touchedHosts.has(`${projectId}\0${node}`);
    const others: HubOtherCheckout[] = touched
      ? [
          ...(current?.otherCheckouts ?? []).filter(
            (other) => !fresh.some((row) => keyOf(node, row.path) === keyOf(node, other.path)),
          ),
          ...fresh,
        ]
      : fresh;
    if (touched && here === undefined) {
      return { ...current!, ...(others.length > 0 ? { otherCheckouts: others } : {}) };
    }
    const newer =
      current?.scan === undefined || here === undefined || here.scanned >= current.scan.scannedAt;
    const {
      scan: _scan,
      otherCheckouts: _others,
      ...base
    } = current ?? { path, stickyPort: null, launchCmd: null };
    if (!newer) return current!;
    return {
      ...base,
      path,
      ...(here !== undefined ? { scan: scanFacts(here) } : {}),
      ...(others.length > 0 ? { otherCheckouts: others } : {}),
    };
  };

  // Folders already linked by path go first, so their remotes are known before remote matching.
  const ordered = [
    ...units.filter((unit) => byPath(unit) !== undefined),
    ...units.filter((unit) => byPath(unit) === undefined),
  ];
  for (const unit of ordered) {
    const found = findExisting(unit);
    const rowCount = [...unit.byNode.values()].flat().length;
    if (found === "ambiguous") {
      skipped += rowCount;
      continue;
    }
    const allRows = [...unit.byNode.values()].flat().sort(byPreference);
    const lead = allRows[0]!;
    const live = allRows.filter(
      (row) => row.category !== "Archive" && !row.flags.some((flag) => DEAD_FLAGS.has(flag)),
    );
    if (found === undefined) {
      const category = live[0]?.category ?? null;
      const engine = lead.lane.toLowerCase();
      const base = slugifyProjectName(lead.name);
      let id = base;
      for (let n = 2; byId.has(id); n += 1) id = `${base}-${n}`;
      const hosts: Record<string, HubProjectHost> = {};
      for (const [node, list] of unit.byNode) {
        hosts[node] = hostFor(node, list, undefined, null);
        touchedHosts.add(`${id}\0${node}`);
        hostsAdded += 1;
      }
      const project: HubProject = {
        id,
        name: lead.name,
        priority: "none",
        status: "active",
        stage: "plan",
        strategyId: null,
        category,
        tags: engine === "other" || engine === "" ? [] : [engine],
        repoUrl: unit.remote === null ? null : repoUrlOf(unit.remote),
        previewUrl: null,
        liveUrl: null,
        siteId: null,
        surface: null,
        notes: "",
        hosts,
        // Imported projects start with the autopilot off; the owner opts each one in.
        autonomy: 0,
        reviewBudget: 2,
        sortIndex: byId.size,
        favorite: false,
        archived: live.length === 0,
        lane: null,
        jobKind: "dev",
        createdAt: context.nowIso,
        updatedAt: context.nowIso,
      };
      byId.set(id, project);
      upserts.set(id, project);
      created += 1;
      continue;
    }
    matched += 1;
    const hosts = { ...found.hosts };
    for (const [node, list] of unit.byNode) {
      if (hosts[node] === undefined) hostsAdded += 1;
      hosts[node] = hostFor(node, list, hosts[node], found.id);
      touchedHosts.add(`${found.id}\0${node}`);
    }
    const engine = lead.lane.toLowerCase();
    const next: HubProject = {
      ...found,
      hosts,
      repoUrl: found.repoUrl ?? (unit.remote === null ? null : repoUrlOf(unit.remote)),
      category: found.category ?? live[0]?.category ?? null,
      tags: found.tags.length > 0 || engine === "other" ? found.tags : [engine],
    };
    if (stable(next) === stable(found)) continue;
    const saved = { ...next, updatedAt: context.nowIso };
    byId.set(saved.id, saved);
    upserts.set(saved.id, saved);
  }

  // Two row groups can land on one project and undo each other; that is not a change.
  const original = new Map(existing.map((project) => [project.id, project]));
  const changed = [...upserts.values()].filter((project) => {
    const before = original.get(project.id);
    return (
      before === undefined ||
      stable({ ...project, updatedAt: null }) !== stable({ ...before, updatedAt: null })
    );
  });
  return {
    upserts: changed,
    rows: rows.length,
    created,
    matched,
    updated: changed.filter((project) => existingIds.has(project.id)).length,
    hostsAdded,
    skipped,
    ambiguous,
  };
}

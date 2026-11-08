/**
 * The Inventory view: what the disk scans say about every folder on every machine. Rows are
 * checkouts (one folder on one machine); the Hub merges a repo across machines into one project,
 * so per-machine numbers count checkouts and project totals say so.
 */
import type { HubCheckoutScan, HubProject } from "@t3tools/contracts";

import { checkoutIssues, scanHasRemote, type AttentionReason } from "./scanAttention.ts";

export const INVENTORY_CATEGORIES = ["Private", "Public", "Other", "Archive"] as const;
const LANE_ORDER = ["VRChat", "Unity", "Unreal", "Web", "Apple", "Python", "Bot", "Tool", "Other"];
const ACTIVITY_MONTHS = 12;

export type InventoryVcsKind = "remote" | "local" | "none";

export interface InventoryCheckout {
  readonly key: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly node: string;
  readonly path: string;
  /** The machine's working checkout, not a copy or backup beside it. */
  readonly primary: boolean;
  /** Null when this machine's checkout has not been scanned. */
  readonly scan: HubCheckoutScan | null;
  /** Archived in the Hub or filed under Archive on disk. */
  readonly archived: boolean;
  readonly reason: AttentionReason | null;
}

function vcsKind(scan: HubCheckoutScan): InventoryVcsKind {
  if (scanHasRemote(scan)) return "remote";
  return scan.vcs.startsWith("git") ? "local" : "none";
}

function inventoryCheckouts(projects: ReadonlyArray<HubProject>): ReadonlyArray<InventoryCheckout> {
  const rows: InventoryCheckout[] = [];
  for (const project of projects) {
    for (const [node, host] of Object.entries(project.hosts)) {
      const folders = [
        { path: host.path, scan: host.scan ?? null, primary: true },
        ...(host.otherCheckouts ?? []).map((other) => ({ ...other, primary: false })),
      ];
      for (const folder of folders) {
        const issues = folder.scan
          ? checkoutIssues(folder.scan, { primary: folder.primary, archived: project.archived })
          : [];
        rows.push({
          key: `${project.id}\u0000${node}\u0000${folder.path}`,
          projectId: project.id,
          projectName: project.name,
          node,
          path: folder.path,
          primary: folder.primary,
          scan: folder.scan,
          archived: project.archived || folder.scan?.category === "Archive",
          reason: issues[0] ?? null,
        });
      }
    }
  }
  return rows;
}

export interface InventoryMachine {
  readonly node: string;
  /** Scanned folders on this machine, copies included. */
  readonly checkouts: number;
  readonly remote: number;
  readonly local: number;
  readonly none: number;
  readonly categories: Readonly<Record<string, number>>;
  /** Checkouts the Hub knows on this machine that no scan has seen. */
  readonly unscanned: number;
  readonly lastScan: string | null;
}

export interface InventoryTotals {
  /** Projects with at least one scanned folder. */
  readonly projects: number;
  /** Projects with no scanned folder on any machine. */
  readonly notScanned: number;
  readonly checkouts: number;
  /** Share of scanned checkouts with a remote, 0–1. */
  readonly remoteShare: number;
  readonly dirtyCheckouts: number;
  readonly unpushedCheckouts: number;
  /** Projects that need attention; matches the projects list's filter. */
  readonly attentionProjects: number;
  readonly attentionCheckouts: number;
}

export interface InventoryLanes {
  readonly lanes: ReadonlyArray<string>;
  readonly nodes: ReadonlyArray<string>;
  /** counts[lane][node] */
  readonly counts: ReadonlyArray<ReadonlyArray<number>>;
  readonly max: number;
}

export interface InventoryActivity {
  /** YYYY-MM, oldest first. */
  readonly months: ReadonlyArray<string>;
  readonly nodes: ReadonlyArray<string>;
  /** counts[month][node] */
  readonly counts: ReadonlyArray<ReadonlyArray<number>>;
  /** Live checkouts last touched before the first month. */
  readonly older: number;
}

export interface Inventory {
  readonly rows: ReadonlyArray<InventoryCheckout>;
  readonly totals: InventoryTotals;
  readonly machines: ReadonlyArray<InventoryMachine>;
  readonly lanes: InventoryLanes;
  readonly activity: InventoryActivity;
  readonly reasonCounts: Readonly<Record<AttentionReason, number>>;
  /** Engine lanes present in the scans, in display order. */
  readonly laneOptions: ReadonlyArray<string>;
}

const laneRank = (lane: string) => {
  const index = LANE_ORDER.indexOf(lane);
  return index === -1 ? LANE_ORDER.length : index;
};
const byLane = (a: string, b: string) => laneRank(a) - laneRank(b) || a.localeCompare(b);

function monthsEnding(today: string): string[] {
  const [year, month] = today.split("-").map(Number);
  const last = year! * 12 + month! - 1;
  return Array.from({ length: ACTIVITY_MONTHS }, (_, index) => {
    const value = last - ACTIVITY_MONTHS + 1 + index;
    return `${Math.floor(value / 12)}-${String((value % 12) + 1).padStart(2, "0")}`;
  });
}

/**
 * `extraNodes` are machines known without any checkout yet (connected Hubs), so each still gets
 * a card. `today` is YYYY-MM-DD and ends the activity chart.
 */
export function buildInventory(input: {
  readonly projects: ReadonlyArray<HubProject>;
  readonly extraNodes?: ReadonlyArray<string>;
  readonly today: string;
}): Inventory {
  const rows = inventoryCheckouts(input.projects);
  const scanned = rows.filter(
    (row): row is InventoryCheckout & { scan: HubCheckoutScan } => row.scan !== null,
  );

  const byNode = new Map<string, InventoryCheckout[]>();
  for (const node of input.extraNodes ?? []) byNode.set(node, []);
  for (const row of rows) {
    const mine = byNode.get(row.node);
    if (mine) mine.push(row);
    else byNode.set(row.node, [row]);
  }
  const machines = [...byNode].map(([node, mine]): InventoryMachine => {
    const scans = mine.flatMap((row) => (row.scan ? [row.scan] : []));
    const kinds = scans.map(vcsKind);
    return {
      node,
      checkouts: scans.length,
      remote: kinds.filter((kind) => kind === "remote").length,
      local: kinds.filter((kind) => kind === "local").length,
      none: kinds.filter((kind) => kind === "none").length,
      categories: Object.fromEntries(
        INVENTORY_CATEGORIES.map((category) => [
          category,
          scans.filter((scan) => scan.category === category).length,
        ]),
      ),
      unscanned: mine.length - scans.length,
      lastScan: scans.reduce<string | null>(
        (latest, scan) => (latest === null || scan.scannedAt > latest ? scan.scannedAt : latest),
        null,
      ),
    };
  });
  machines.sort((a, b) => b.checkouts - a.checkouts || a.node.localeCompare(b.node));
  const nodes = machines.map((machine) => machine.node);

  const scannedProjects = new Set(scanned.map((row) => row.projectId));
  const attentionRows = rows.filter((row) => row.reason !== null);
  const totals: InventoryTotals = {
    projects: scannedProjects.size,
    notScanned: input.projects.filter((project) => !scannedProjects.has(project.id)).length,
    checkouts: scanned.length,
    remoteShare:
      scanned.length === 0
        ? 0
        : scanned.filter((row) => vcsKind(row.scan) === "remote").length / scanned.length,
    dirtyCheckouts: scanned.filter((row) => (row.scan.dirty ?? 0) > 0).length,
    unpushedCheckouts: scanned.filter((row) => (row.scan.ahead ?? 0) > 0).length,
    attentionProjects: new Set(attentionRows.map((row) => row.projectId)).size,
    attentionCheckouts: attentionRows.length,
  };

  const laneOptions = [...new Set(scanned.map((row) => row.scan.engine))].sort(byLane);
  const laneCounts = laneOptions.map((lane) =>
    nodes.map(
      (node) => scanned.filter((row) => row.node === node && row.scan.engine === lane).length,
    ),
  );

  const months = monthsEnding(input.today);
  const live = scanned.filter(
    (row) => row.scan.category !== "Archive" && row.scan.lastActivity !== null,
  );
  const activityCounts = months.map((month) =>
    nodes.map(
      (node) =>
        live.filter((row) => row.node === node && row.scan.lastActivity!.startsWith(month)).length,
    ),
  );

  const reasonCounts: Record<AttentionReason, number> = {
    "at-risk": 0,
    duplicate: 0,
    unpushed: 0,
    uncommitted: 0,
    "no-remote": 0,
  };
  for (const row of attentionRows) reasonCounts[row.reason!] += 1;

  return {
    rows,
    totals,
    machines,
    lanes: {
      lanes: laneOptions,
      nodes,
      counts: laneCounts,
      max: Math.max(0, ...laneCounts.flat()),
    },
    activity: {
      months,
      nodes,
      counts: activityCounts,
      older: live.filter((row) => row.scan.lastActivity!.slice(0, 7) < months[0]!).length,
    },
    reasonCounts,
    laneOptions,
  };
}

/** Checkouts under one reason, most changed files first. */
export function attentionList(
  rows: ReadonlyArray<InventoryCheckout>,
  reason: AttentionReason,
): ReadonlyArray<InventoryCheckout> {
  return rows
    .filter((row) => row.reason === reason)
    .sort(
      (a, b) =>
        (b.scan?.dirty ?? 0) - (a.scan?.dirty ?? 0) || a.projectName.localeCompare(b.projectName),
    );
}

/** The figure on the right of an attention row. */
export function attentionStat(row: InventoryCheckout): string {
  const scan = row.scan;
  if (scan === null) return "";
  if (row.reason === "unpushed") return `+${scan.ahead} ahead`;
  if ((scan.dirty ?? 0) > 0) return `${scan.dirty} uncommitted`;
  return scan.vcs;
}

export const UNSCANNED = "unscanned";

export interface InventoryFilters {
  readonly query: string;
  readonly node: string;
  readonly category: string;
  readonly lane: string;
  /** A scan `vcs` value, or `UNSCANNED`. */
  readonly vcs: string;
  readonly attentionOnly: boolean;
}

export type InventorySortKey =
  | "name"
  | "node"
  | "lane"
  | "category"
  | "vcs"
  | "branch"
  | "ahead"
  | "dirty"
  | "lastActivity"
  | "size";

export interface InventorySort {
  readonly key: InventorySortKey;
  readonly direction: "asc" | "desc";
}

/** Numbers and dates read best biggest or newest first. */
export const defaultSortDirection = (key: InventorySortKey): InventorySort["direction"] =>
  key === "ahead" || key === "dirty" || key === "lastActivity" || key === "size" ? "desc" : "asc";

function sortValue(row: InventoryCheckout, key: InventorySortKey): string | number | null {
  const scan = row.scan;
  switch (key) {
    case "name":
      return row.projectName;
    case "node":
      return row.node;
    case "lane":
      return scan?.engine ?? null;
    case "category": {
      const index = scan ? INVENTORY_CATEGORIES.indexOf(scan.category as never) : -1;
      return scan === null ? null : index === -1 ? INVENTORY_CATEGORIES.length : index;
    }
    case "vcs":
      return scan?.vcs ?? null;
    case "branch":
      return scan?.branch ?? null;
    case "ahead":
      return scan?.ahead ?? null;
    case "dirty":
      return scan?.dirty ?? null;
    case "lastActivity":
      return scan?.lastActivity ?? null;
    case "size":
      return scan?.sizeGb ?? null;
  }
}

/** Filters and sorts table rows. Rows with no value for the sort key go last either way. */
export function filterInventory(
  rows: ReadonlyArray<InventoryCheckout>,
  filters: InventoryFilters,
  sort: InventorySort,
): ReadonlyArray<InventoryCheckout> {
  const query = filters.query.trim().toLowerCase();
  const sign = sort.direction === "asc" ? 1 : -1;
  return rows
    .filter(
      (row) =>
        (filters.node === "" || row.node === filters.node) &&
        (filters.category === "" || row.scan?.category === filters.category) &&
        (filters.lane === "" || row.scan?.engine === filters.lane) &&
        (filters.vcs === "" ||
          (filters.vcs === UNSCANNED ? row.scan === null : row.scan?.vcs === filters.vcs)) &&
        (!filters.attentionOnly || row.reason !== null) &&
        (query === "" ||
          row.projectName.toLowerCase().includes(query) ||
          (row.scan?.branch ?? "").toLowerCase().includes(query)),
    )
    .sort((a, b) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      if (x === null || x === "") return y === null || y === "" ? 0 : 1;
      if (y === null || y === "") return -1;
      const order =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y), undefined, { sensitivity: "base" });
      return (order || a.projectName.localeCompare(b.projectName)) * sign;
    });
}

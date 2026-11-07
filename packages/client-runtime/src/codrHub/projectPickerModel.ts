import type {
  EnvironmentId,
  HubMergedProjectView,
  HubStrategyPriority,
  HubUpsertProjectInput,
  ProjectIconColor,
} from "@t3tools/contracts";

import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import { compareHubProjectViews, type HubProjectSort } from "./hubFormat.ts";

/**
 * Codr-Hub new-thread project picker. Favourites, tags and manual order live
 * on the portfolio project whose checkout on a node matches a T3 project's
 * workspace root, so every mesh node and client sees the same picker.
 */

interface PickerGroup {
  readonly projectKey: string;
  readonly displayName: string;
  readonly memberProjects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
  }>;
}

export interface PickerRow<G extends PickerGroup = PickerGroup> {
  readonly group: G;
  readonly hub: HubMergedProjectView | null;
}

const linkKey = (nodeName: string, path: string) =>
  `${nodeName}\0${normalizeProjectPathForComparison(path)}`;

/**
 * Each node's checkout. `hosts` adds machines that have a linked stock T3 but no Hub server,
 * which no snapshot reports as a node.
 */
const checkoutKeys = (view: HubMergedProjectView) => [
  ...view.nodes.flatMap((node) =>
    node.localPath === null ? [] : [linkKey(node.nodeName, node.localPath)],
  ),
  ...Object.entries(view.project.hosts).map(([nodeName, host]) => linkKey(nodeName, host.path)),
];

/** Pairs each T3 project group with the portfolio project checked out at one of its paths. */
export function linkPickerRows<G extends PickerGroup>(
  groups: ReadonlyArray<G>,
  hubProjects: ReadonlyArray<HubMergedProjectView>,
  nodeNameByEnvironmentId: ReadonlyMap<EnvironmentId, string>,
): PickerRow<G>[] {
  const byCheckout = new Map<string, HubMergedProjectView>();
  for (const view of hubProjects) {
    for (const key of checkoutKeys(view)) byCheckout.set(key, view);
  }
  return groups.map((group) => {
    for (const member of group.memberProjects) {
      const nodeName = nodeNameByEnvironmentId.get(member.environmentId);
      const hub =
        nodeName === undefined
          ? undefined
          : byCheckout.get(linkKey(nodeName, member.workspaceRoot));
      if (hub) return { group, hub };
    }
    return { group, hub: null };
  });
}

/** Arranged projects by manual order; projects never arranged follow, by name. */
function comparePickerRows(a: PickerRow, b: PickerRow): number {
  if (a.hub && b.hub) {
    return (
      a.hub.project.sortIndex - b.hub.project.sortIndex ||
      a.group.displayName.localeCompare(b.group.displayName)
    );
  }
  if (a.hub) return -1;
  if (b.hub) return 1;
  return a.group.displayName.localeCompare(b.group.displayName);
}

export interface PickerSections<G extends PickerGroup> {
  readonly favorites: PickerRow<G>[];
  readonly others: PickerRow<G>[];
}

export function pickerSections<G extends PickerGroup>(
  rows: ReadonlyArray<PickerRow<G>>,
): PickerSections<G> {
  const sorted = [...rows].sort(comparePickerRows);
  return {
    favorites: sorted.filter((row) => row.hub?.project.favorite === true),
    others: sorted.filter((row) => row.hub?.project.favorite !== true),
  };
}

/**
 * Picker order for a chosen sort. "favorites" is the default picker order. Hub sorts put
 * projects that are not in the Hub last, by name; "recent" uses each group's latest activity.
 */
export function sortPickerRows<G extends PickerGroup>(
  rows: ReadonlyArray<PickerRow<G>>,
  sort: HubProjectSort,
  options: {
    readonly strategy: ReadonlyArray<HubStrategyPriority>;
    readonly activeAt: (group: G) => string | null;
  },
): PickerRow<G>[] {
  if (sort === "favorites") {
    const { favorites, others } = pickerSections(rows);
    return [...favorites, ...others];
  }
  const byName = (a: PickerRow<G>, b: PickerRow<G>) =>
    a.group.displayName.localeCompare(b.group.displayName);
  if (sort === "name") return [...rows].sort(byName);
  if (sort === "recent") {
    return [...rows].sort(
      (a, b) =>
        (options.activeAt(b.group) ?? "").localeCompare(options.activeAt(a.group) ?? "") ||
        byName(a, b),
    );
  }
  const compareHub = compareHubProjectViews(sort, options.strategy);
  return [...rows].sort((a, b) => {
    if (a.hub && b.hub) return compareHub(a.hub, b.hub);
    if (a.hub) return -1;
    if (b.hub) return 1;
    return byName(a, b);
  });
}

export function rowTags(row: PickerRow): ReadonlyArray<string> {
  return row.hub?.project.tags ?? [];
}

export function allPickerTags(rows: ReadonlyArray<PickerRow>): string[] {
  return [...new Set(rows.flatMap(rowTags))].sort((a, b) => a.localeCompare(b));
}

/** Matches the name or any tag, and requires `tag` when one is chosen. */
export function rowMatches(row: PickerRow, query: string, tag: string | null): boolean {
  const tags = rowTags(row);
  if (tag !== null && !tags.includes(tag)) return false;
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return true;
  return (
    row.group.displayName.toLocaleLowerCase().includes(needle) ||
    tags.some((entry) => entry.toLocaleLowerCase().includes(needle))
  );
}

/** Splits free text such as "web, client  ops" into unique tags. */
export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\n]/)
        .map((tag) => tag.trim())
        .filter((tag) => tag !== ""),
    ),
  ];
}

export interface PickerWrite {
  readonly environmentId: EnvironmentId;
  readonly input: HubUpsertProjectInput;
}

/**
 * The environments that answer Hub writes: the first per node name. Later ones are a node's
 * linked stock T3 (see hubMerge), where threads should go.
 */
function hubEnvironments(
  nodeNameByEnvironmentId: ReadonlyMap<EnvironmentId, string>,
): Set<EnvironmentId> {
  const seen = new Set<string>();
  const hubs = new Set<EnvironmentId>();
  for (const [id, nodeName] of nodeNameByEnvironmentId) {
    if (seen.has(nodeName)) continue;
    seen.add(nodeName);
    hubs.add(id);
  }
  return hubs;
}

function byPrimaryFirst(
  nodeNameByEnvironmentId: ReadonlyMap<EnvironmentId, string>,
  primaryEnvironmentId: EnvironmentId | null,
): EnvironmentId[] {
  return [...hubEnvironments(nodeNameByEnvironmentId)].sort(
    (a, b) => Number(b === primaryEnvironmentId) - Number(a === primaryEnvironmentId),
  );
}

/** The connected environment whose portfolio has this project, preferring the primary one. */
export function hubWriteEnvironment(
  view: HubMergedProjectView,
  nodeNameByEnvironmentId: ReadonlyMap<EnvironmentId, string>,
  primaryEnvironmentId: EnvironmentId | null,
): EnvironmentId | null {
  const nodeNames = new Set(view.nodes.map((node) => node.nodeName));
  return (
    byPrimaryFirst(nodeNameByEnvironmentId, primaryEnvironmentId).find((id) =>
      nodeNames.has(nodeNameByEnvironmentId.get(id)!),
    ) ?? null
  );
}

/** The T3 project checked out at this portfolio project's path, for starting a thread in it. */
export function t3ProjectForHubView<
  P extends { readonly environmentId: EnvironmentId; readonly workspaceRoot: string },
>(
  view: HubMergedProjectView,
  projects: ReadonlyArray<P>,
  nodeNameByEnvironmentId: ReadonlyMap<EnvironmentId, string>,
): P | null {
  const checkouts = new Set(checkoutKeys(view));
  const matches = projects.filter((project) => {
    const nodeName = nodeNameByEnvironmentId.get(project.environmentId);
    return nodeName !== undefined && checkouts.has(linkKey(nodeName, project.workspaceRoot));
  });
  if (matches.length < 2) return matches[0] ?? null;
  const hubs = hubEnvironments(nodeNameByEnvironmentId);
  return matches.find((project) => !hubs.has(project.environmentId)) ?? matches[0]!;
}

export type HubThreadTarget<P> =
  | { readonly kind: "open"; readonly project: P }
  | {
      readonly kind: "add";
      readonly environmentId: EnvironmentId;
      readonly nodeName: string;
      readonly workspaceRoot: string;
    }
  /** No connected machine has the folder; `nodeNames` are the offline ones that do. */
  | { readonly kind: "unavailable"; readonly nodeNames: ReadonlyArray<string> };

/**
 * Where starting a thread from a portfolio project goes: its T3 project, or
 * else its folder on a connected machine to add as a T3 project first.
 */
export function hubThreadTarget<
  P extends { readonly environmentId: EnvironmentId; readonly workspaceRoot: string },
>(
  view: HubMergedProjectView,
  projects: ReadonlyArray<P>,
  nodeNameByEnvironmentId: ReadonlyMap<EnvironmentId, string>,
): HubThreadTarget<P> {
  const project = t3ProjectForHubView(view, projects, nodeNameByEnvironmentId);
  if (project) return { kind: "open", project };
  const checkouts = view.nodes.filter((node) => node.localPath !== null && node.pathExists);
  const hubs = hubEnvironments(nodeNameByEnvironmentId);
  // A node's linked stock T3 first: threads go where the owner works.
  const environments = [...nodeNameByEnvironmentId].sort(
    ([a], [b]) => Number(hubs.has(a)) - Number(hubs.has(b)),
  );
  for (const [environmentId, nodeName] of environments) {
    const node = checkouts.find((checkout) => checkout.nodeName === nodeName);
    if (node) return { kind: "add", environmentId, nodeName, workspaceRoot: node.localPath! };
  }
  // Machines with a linked T3 but no Hub are known only from `hosts`.
  const hubNodes = new Set(view.nodes.map((node) => node.nodeName));
  return {
    kind: "unavailable",
    nodeNames: [
      ...checkouts.map((node) => node.nodeName),
      ...Object.keys(view.project.hosts).filter((nodeName) => !hubNodes.has(nodeName)),
    ],
  };
}

/**
 * The environment to write a row's portfolio change through, preferring the
 * primary one. A linked row needs a node whose portfolio already has the
 * project; an unlinked row is created on a node where it is checked out.
 * Returns null when no environment can take the write.
 */
export function pickerWriteFor(
  row: PickerRow,
  patch: Omit<HubUpsertProjectInput, "id" | "localPath">,
  nodeNameByEnvironmentId: ReadonlyMap<EnvironmentId, string>,
  primaryEnvironmentId: EnvironmentId | null,
): PickerWrite | null {
  if (row.hub) {
    const environmentId = hubWriteEnvironment(
      row.hub,
      nodeNameByEnvironmentId,
      primaryEnvironmentId,
    );
    return environmentId === null
      ? null
      : { environmentId, input: { id: row.hub.project.id, ...patch } };
  }
  const environmentIds = byPrimaryFirst(nodeNameByEnvironmentId, primaryEnvironmentId);
  for (const environmentId of environmentIds) {
    const nodeName = nodeNameByEnvironmentId.get(environmentId);
    const member = row.group.memberProjects.find(
      (project) => nodeNameByEnvironmentId.get(project.environmentId) === nodeName,
    );
    if (member) {
      return {
        environmentId,
        input: { name: row.group.displayName, localPath: member.workspaceRoot, ...patch },
      };
    }
  }
  return null;
}

/**
 * Moves one row within a section and returns the writes that store the new
 * order, batched per environment. Only rows whose position changes, or that
 * have no portfolio entry yet, are written. Null when a row cannot be stored.
 */
export function planPickerReorder(
  section: ReadonlyArray<PickerRow>,
  fromIndex: number,
  toIndex: number,
  nodeNameByEnvironmentId: ReadonlyMap<EnvironmentId, string>,
  primaryEnvironmentId: EnvironmentId | null,
): Map<EnvironmentId, HubUpsertProjectInput[]> | null {
  if (fromIndex === toIndex) return new Map();
  const next = [...section];
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) return new Map();
  next.splice(toIndex, 0, moved);
  const batches = new Map<EnvironmentId, HubUpsertProjectInput[]>();
  for (const [sortIndex, row] of next.entries()) {
    if (row.hub?.project.sortIndex === sortIndex) continue;
    const write = pickerWriteFor(row, { sortIndex }, nodeNameByEnvironmentId, primaryEnvironmentId);
    if (write === null) return null;
    batches.set(write.environmentId, [...(batches.get(write.environmentId) ?? []), write.input]);
  }
  return batches;
}

// Gray is the "no colour" tone, so automatic machine colours skip it.
const AUTO_MACHINE_COLORS: ReadonlyArray<ProjectIconColor> = [
  "blue",
  "emerald",
  "orange",
  "violet",
  "rose",
  "teal",
  "amber",
  "sky",
  "lime",
  "fuchsia",
  "indigo",
  "red",
];

/** Stable colour for a machine name, so every client paints a node the same way. */
export function autoMachineColor(machineKey: string): ProjectIconColor {
  let hash = 0;
  for (const char of machineKey) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AUTO_MACHINE_COLORS[hash % AUTO_MACHINE_COLORS.length]!;
}

export function machineColor(
  machineKey: string,
  nodeColors: Readonly<Record<string, ProjectIconColor>>,
): ProjectIconColor {
  return nodeColors[machineKey] ?? autoMachineColor(machineKey);
}

import type {
  EnvironmentId,
  HubMergedProjectView,
  HubUpsertProjectInput,
  ProjectIconColor,
} from "@t3tools/contracts";

import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

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

/** Pairs each T3 project group with the portfolio project checked out at one of its paths. */
export function linkPickerRows<G extends PickerGroup>(
  groups: ReadonlyArray<G>,
  hubProjects: ReadonlyArray<HubMergedProjectView>,
  nodeNameByEnvironmentId: ReadonlyMap<EnvironmentId, string>,
): PickerRow<G>[] {
  const byCheckout = new Map<string, HubMergedProjectView>();
  for (const view of hubProjects) {
    for (const node of view.nodes) {
      if (node.localPath !== null) byCheckout.set(linkKey(node.nodeName, node.localPath), view);
    }
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
export function comparePickerRows(a: PickerRow, b: PickerRow): number {
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
  const environmentIds = [...nodeNameByEnvironmentId.keys()].sort(
    (a, b) => Number(b === primaryEnvironmentId) - Number(a === primaryEnvironmentId),
  );
  if (row.hub) {
    const nodeNames = new Set(row.hub.nodes.map((node) => node.nodeName));
    const environmentId = environmentIds.find((id) =>
      nodeNames.has(nodeNameByEnvironmentId.get(id)!),
    );
    return environmentId === undefined
      ? null
      : { environmentId, input: { id: row.hub.project.id, ...patch } };
  }
  for (const environmentId of environmentIds) {
    const member = row.group.memberProjects.find(
      (project) => project.environmentId === environmentId,
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

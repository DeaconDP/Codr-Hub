/**
 * What a disk scan says needs the owner's attention: one rule set, read per checkout, that drives
 * the row chips, the Needs attention filter and the Inventory view. Reads only the scan facts on
 * `project.hosts`.
 */
import type { HubCheckoutScan, HubImportResult, HubProject } from "@t3tools/contracts";

export type ScanChipTone = "danger" | "warning" | "muted";

export interface ScanChip {
  readonly label: string;
  readonly tone: ScanChipTone;
  /** Machines the chip applies to, for a tooltip. */
  readonly nodes: ReadonlyArray<string>;
}

export type AttentionReason = "at-risk" | "duplicate" | "unpushed" | "uncommitted" | "no-remote";

/** In priority order: a checkout is listed under its first reason. */
export const ATTENTION_REASONS: ReadonlyArray<{
  readonly value: AttentionReason;
  readonly label: string;
  readonly why: string;
}> = [
  { value: "at-risk", label: "At risk", why: "On a drive marked at risk" },
  { value: "duplicate", label: "Duplicate or half copy", why: "Another folder of this project" },
  { value: "unpushed", label: "Unpushed commits", why: "Commits only on this machine" },
  { value: "uncommitted", label: "Lots uncommitted", why: "20 or more changed files" },
  { value: "no-remote", label: "Code with no remote", why: "Not pushed anywhere" },
];

const DIRTY_LIMIT = 20;
const ENGINES = new Set(["unreal", "unity", "vrchat"]);
const OWN_CODE = new Set(["Private", "Public"]);
const FLAG_TONE: Record<string, ScanChipTone> = {
  "at-risk": "danger",
  duplicate: "warning",
  "half-copy": "warning",
  copy: "muted",
  backup: "muted",
  "third-party": "muted",
  "legacy-path": "muted",
  "outside-workshop": "muted",
  "stale-scan": "muted",
};
const TONE_ORDER: Record<ScanChipTone, number> = { danger: 0, warning: 1, muted: 2 };

export const scanHasRemote = (scan: HubCheckoutScan) =>
  scan.remote !== null || scan.vcs === "perforce";

/**
 * Every reason a checkout needs a look, in `ATTENTION_REASONS` order. Archived work only counts
 * when it is at risk. Dirt, lag and a missing remote are facts of the working checkout (`primary`);
 * a copy's are not the owner's problem. Engine folders were mostly never in git.
 */
export function checkoutIssues(
  scan: HubCheckoutScan,
  context: { readonly primary: boolean; readonly archived: boolean },
): ReadonlyArray<AttentionReason> {
  const issues: AttentionReason[] = [];
  if (scan.flags.includes("at-risk")) issues.push("at-risk");
  if (context.archived || scan.category === "Archive") return issues;
  if (scan.flags.includes("duplicate") || scan.flags.includes("half-copy")) {
    issues.push("duplicate");
  }
  if (!context.primary) return issues;
  if ((scan.ahead ?? 0) > 0) issues.push("unpushed");
  if ((scan.dirty ?? 0) >= DIRTY_LIMIT) issues.push("uncommitted");
  if (
    !scanHasRemote(scan) &&
    OWN_CODE.has(scan.category) &&
    !ENGINES.has(scan.engine.toLowerCase())
  ) {
    issues.push("no-remote");
  }
  return issues;
}

/** Each scanned folder of a project: the working checkout per machine, then its other folders. */
function projectScans(project: HubProject): ReadonlyArray<{
  readonly node: string;
  readonly scan: HubCheckoutScan;
  readonly primary: boolean;
}> {
  return Object.entries(project.hosts).flatMap(([node, host]) => [
    ...(host.scan ? [{ node, scan: host.scan, primary: true }] : []),
    ...(host.otherCheckouts ?? []).map((other) => ({ node, scan: other.scan, primary: false })),
  ]);
}

export function projectScanChips(project: HubProject): ReadonlyArray<ScanChip> {
  const chips = new Map<string, { tone: ScanChipTone; nodes: Set<string> }>();
  const add = (label: string, tone: ScanChipTone, node: string) => {
    const chip = chips.get(label) ?? { tone, nodes: new Set<string>() };
    chip.nodes.add(node);
    chips.set(label, chip);
  };
  for (const { node, scan, primary } of projectScans(project)) {
    for (const flag of scan.flags) add(flag, FLAG_TONE[flag] ?? "muted", node);
    for (const issue of checkoutIssues(scan, { primary, archived: project.archived })) {
      if (issue === "unpushed") add(`${scan.ahead} unpushed`, "warning", node);
      if (issue === "uncommitted") add(`${scan.dirty} changed`, "warning", node);
      if (issue === "no-remote") add("no remote", "warning", node);
    }
  }
  return [...chips]
    .map(([label, chip]) => ({ label, tone: chip.tone, nodes: [...chip.nodes] }))
    .sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || a.label.localeCompare(b.label));
}

export function needsAttention(project: HubProject): boolean {
  return projectScans(project).some(
    ({ scan, primary }) => checkoutIssues(scan, { primary, archived: project.archived }).length > 0,
  );
}

/** One line for a scan import result. */
export function scanImportSummary(result: HubImportResult): string {
  const lead = result.dryRun ? "Would add" : "Added";
  return [
    `${lead} ${result.imported} new, matched ${result.matched ?? 0}, ${result.hostsAdded ?? 0} machine checkouts, ${result.updated} updated, ${result.skipped} skipped from ${result.rows ?? 0} rows.`,
    (result.ambiguous?.length ?? 0) > 0
      ? `${result.ambiguous!.length} ${result.ambiguous!.length === 1 ? "needs" : "need"} a look.`
      : null,
  ]
    .filter((part) => part !== null)
    .join(" ");
}

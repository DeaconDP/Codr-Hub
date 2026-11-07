/**
 * What a disk scan says needs the owner's attention, per project: chips for the row and the
 * Attention filter. Reads only the scan facts on `project.hosts`.
 */
import type { HubCheckoutScan, HubImportResult, HubProject } from "@t3tools/contracts";

export type ScanChipTone = "danger" | "warning" | "muted";

export interface ScanChip {
  readonly label: string;
  readonly tone: ScanChipTone;
  /** Machines the chip applies to, for a tooltip. */
  readonly nodes: ReadonlyArray<string>;
  /** Counts toward the Attention filter. */
  readonly attention: boolean;
}

const DIRTY_LIMIT = 20;
const ENGINES = new Set(["unreal", "unity", "vrchat"]);
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
const ATTENTION_FLAGS = new Set(["at-risk", "duplicate", "half-copy"]);
const TONE_ORDER: Record<ScanChipTone, number> = { danger: 0, warning: 1, muted: 2 };

const noRemote = (scan: HubCheckoutScan) =>
  scan.remote === null &&
  scan.vcs !== "perforce" &&
  scan.category !== "Archive" &&
  !ENGINES.has(scan.engine.toLowerCase());

export function projectScanChips(project: HubProject): ReadonlyArray<ScanChip> {
  const chips = new Map<string, { tone: ScanChipTone; nodes: Set<string>; attention: boolean }>();
  const add = (label: string, tone: ScanChipTone, node: string, attention: boolean) => {
    const chip = chips.get(label) ?? { tone, nodes: new Set<string>(), attention };
    chip.nodes.add(node);
    chips.set(label, chip);
  };
  for (const [node, host] of Object.entries(project.hosts)) {
    const scans = [
      ...(host.scan ? [host.scan] : []),
      ...(host.otherCheckouts ?? []).map((other) => other.scan),
    ];
    for (const scan of scans) {
      for (const flag of scan.flags) {
        add(flag, FLAG_TONE[flag] ?? "muted", node, ATTENTION_FLAGS.has(flag));
      }
    }
    // Working-checkout facts; copies' dirt and lag are not the owner's problem.
    const scan = host.scan;
    if (scan === undefined) continue;
    if ((scan.dirty ?? 0) >= DIRTY_LIMIT) add(`${scan.dirty} changed`, "warning", node, true);
    if ((scan.ahead ?? 0) > 0) add(`${scan.ahead} unpushed`, "warning", node, true);
    if (noRemote(scan)) add("no remote", "warning", node, true);
  }
  return [...chips]
    .map(([label, chip]) => ({
      label,
      tone: chip.tone,
      nodes: [...chip.nodes],
      attention: chip.attention,
    }))
    .sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || a.label.localeCompare(b.label));
}

/** Archived projects still need attention when their only copy is at risk. */
export function needsAttention(project: HubProject): boolean {
  const chips = projectScanChips(project);
  return project.archived
    ? chips.some((chip) => chip.label === "at-risk")
    : chips.some((chip) => chip.attention);
}

/** One line for a scan import result. */
export function scanImportSummary(result: HubImportResult): string {
  const lead = result.dryRun ? "Would add" : "Added";
  return [
    `${lead} ${result.imported} new, matched ${result.matched ?? 0}, ${result.hostsAdded ?? 0} machine checkouts, ${result.updated} updated, ${result.skipped} skipped from ${result.rows ?? 0} rows.`,
    (result.ambiguous?.length ?? 0) > 0 ? `${result.ambiguous!.length} need a look.` : null,
  ]
    .filter((part) => part !== null)
    .join(" ");
}

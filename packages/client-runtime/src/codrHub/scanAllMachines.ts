/** Scan all machines: scan every connected Hub's disks at once and report one line per machine. */
import type { EnvironmentId, HubImportResult, HubMergedProjectView } from "@t3tools/contracts";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "../state/runtime.ts";
import { scanImportSummary } from "./scanAttention.ts";

export interface ScanAllTarget {
  readonly environmentId: EnvironmentId;
  readonly nodeName: string;
}

export interface ScanAllPlan {
  /** One connected Hub per machine. */
  readonly targets: ReadonlyArray<ScanAllTarget>;
  /** Machines with checkouts in the portfolio but no connected Hub. */
  readonly unreachable: ReadonlyArray<string>;
}

export interface ScanAllLine {
  readonly nodeName: string;
  readonly text: string;
  readonly ok: boolean;
}

export function scanAllPlan(input: {
  /** Environments that answered as Hubs, in merge order. */
  readonly hubEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly nodeNameByEnvironmentId: ReadonlyMap<EnvironmentId, string>;
  readonly projects: ReadonlyArray<HubMergedProjectView>;
}): ScanAllPlan {
  const connected = new Set(input.connectedEnvironmentIds);
  const byNode = new Map<string, EnvironmentId>();
  for (const environmentId of input.hubEnvironmentIds) {
    const nodeName = input.nodeNameByEnvironmentId.get(environmentId);
    if (nodeName === undefined || !connected.has(environmentId) || byNode.has(nodeName)) continue;
    byNode.set(nodeName, environmentId);
  }
  const known = new Set(
    input.projects.flatMap((view) => [
      ...Object.keys(view.project.hosts),
      ...view.nodes.map((node) => node.nodeName),
    ]),
  );
  return {
    targets: [...byNode]
      .map(([nodeName, environmentId]) => ({ environmentId, nodeName }))
      .sort((a, b) => a.nodeName.localeCompare(b.nodeName)),
    unreachable: [...known].filter((nodeName) => !byNode.has(nodeName)).sort(),
  };
}

const UNREACHABLE = "Not reachable: run `npm run codr:scan` there and import the file.";

/** An older Hub rejects the `scan` source while decoding the request. */
const isOutdatedHub = (message: string) => /expected/i.test(message) && message.includes('"scan"');

function failureText(result: AtomCommandResult<unknown, unknown> & { _tag: "Failure" }): string {
  if (isAtomCommandInterrupted(result)) return "Cancelled.";
  const failure = squashAtomCommandFailure(result);
  const message = failure instanceof Error ? failure.message : "The scan failed.";
  return isOutdatedHub(message) ? "Needs the latest Codr-Hub to scan." : message;
}

/** Scans every target in parallel; resolves once all have answered. */
export async function runScanAll(
  plan: ScanAllPlan,
  scan: (target: ScanAllTarget) => Promise<AtomCommandResult<HubImportResult, unknown>>,
): Promise<ReadonlyArray<ScanAllLine>> {
  const scanned = await Promise.all(
    plan.targets.map(async (target): Promise<ScanAllLine> => {
      const result = await scan(target);
      return result._tag === "Success"
        ? { nodeName: target.nodeName, text: scanImportSummary(result.value), ok: true }
        : { nodeName: target.nodeName, text: failureText(result), ok: false };
    }),
  );
  return [
    ...scanned,
    ...plan.unreachable.map((nodeName) => ({ nodeName, text: UNREACHABLE, ok: false })),
  ];
}

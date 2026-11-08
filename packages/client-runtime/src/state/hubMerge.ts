import type {
  EnvironmentId,
  HubInsights,
  HubMergedProjectView,
  HubSnapshot,
} from "@t3tools/contracts";
import { mergeHubProjectViews } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";

export type HubMergedProjectsLive = {
  readonly projects: ReadonlyArray<HubMergedProjectView>;
  /** First successful snapshot, for strategy labels if the chosen env is down. */
  readonly anySnapshot: HubSnapshot | null;
  /**
   * Hub node name each answering environment reports, then the node name of each linked stock
   * T3 a Hub read (`t3Sync.t3Sources`), for linking T3 projects by path. Hub environments come first,
   * so the first id per node name is the one that answers Hub writes.
   */
  readonly nodeNameByEnvironmentId: ReadonlyMap<EnvironmentId, string>;
  /** Environments that answered with a Hub snapshot, unlike the stock T3 ones above. */
  readonly hubEnvironmentIds: ReadonlyArray<EnvironmentId>;
  /** First failure. Others may still have answered — this is not fatal. */
  readonly error: string | null;
  readonly isPending: boolean;
};

const EMPTY_MERGED: HubMergedProjectsLive = {
  projects: [],
  anySnapshot: null,
  nodeNameByEnvironmentId: new Map(),
  hubEnvironmentIds: [],
  error: null,
  isPending: false,
};

function formatMergeError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The environment request failed.";
}

/**
 * Family key for `createHubMergedProjectsAtomFamily`, or null when no environment can answer.
 * A reconnecting environment stays in the merge, so a server restart or socket swap keeps its
 * last snapshot instead of leaving only the other machines' portfolios on screen.
 */
export function hubMergedProjectsKey(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly phase: EnvironmentConnectionPhase;
  }>,
): string | null {
  const members = environments.flatMap(({ environmentId, phase }) =>
    phase === "connected" || phase === "reconnecting"
      ? [[environmentId, phase === "connected"] as const]
      : [],
  );
  return members.length === 0 ? null : JSON.stringify(members);
}

/**
 * React cannot subscribe to a variable-length atom list, so Hub-eligible
 * `hubLive` reads fan out inside one derived atom keyed by `hubMergedProjectsKey`.
 */
export function createHubMergedProjectsAtomFamily(
  hubLive: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: Record<string, never>;
  }) => Atom.Atom<AsyncResult.AsyncResult<HubSnapshot, unknown>>,
) {
  const family = Atom.family((key: string) =>
    Atom.make((get): HubMergedProjectsLive => {
      const members = JSON.parse(key) as ReadonlyArray<
        readonly [environmentId: EnvironmentId, connected: boolean]
      >;
      const snapshots: HubSnapshot[] = [];
      const nodeNameByEnvironmentId = new Map<EnvironmentId, string>();
      let error: string | null = null;
      let isPending = false;
      for (const [environmentId, connected] of members) {
        const result = get(hubLive({ environmentId, input: {} }));
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value !== null) {
          snapshots.push(value);
          nodeNameByEnvironmentId.set(environmentId, value.nodeName);
        }
        // A reconnecting environment only lends its last snapshot; a machine that never
        // answers must not hold the merge pending.
        if (!connected) continue;
        isPending ||= result.waiting;
        if (result._tag === "Failure" && error === null) {
          error = formatMergeError(result.cause);
        }
      }
      const hubEnvironmentIds = [...nodeNameByEnvironmentId.keys()];
      for (const value of snapshots) {
        for (const source of value.t3Sync?.t3Sources ?? []) {
          if (!nodeNameByEnvironmentId.has(source.environmentId)) {
            nodeNameByEnvironmentId.set(source.environmentId, source.nodeName);
          }
        }
      }
      return {
        projects: mergeHubProjectViews(snapshots),
        anySnapshot: snapshots[0] ?? null,
        nodeNameByEnvironmentId,
        hubEnvironmentIds,
        error,
        isPending,
      };
    }).pipe(Atom.withLabel(`hub-merged-projects:${key}`)),
  );
  const empty = Atom.make(EMPTY_MERGED).pipe(Atom.withLabel("hub-merged-projects:empty"));
  return { family, empty };
}

export type HubMergedInsightsLive = {
  /** One entry per answering environment, in the order of the requested ids. */
  readonly insights: ReadonlyArray<HubInsights>;
  /** First failure. Others may still have answered — this is not fatal. */
  readonly error: string | null;
  readonly isPending: boolean;
};

const EMPTY_INSIGHTS: HubMergedInsightsLive = { insights: [], error: null, isPending: false };

/**
 * Dashboard insights fanned out over environments, keyed by
 * `JSON.stringify(environmentIds)`. Refreshing the merged atom re-runs every
 * environment's query (each server still serves its own short cache).
 */
export function createHubMergedInsightsAtomFamily(
  hubInsights: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: Record<string, never>;
  }) => Atom.Atom<AsyncResult.AsyncResult<HubInsights, unknown>>,
) {
  const family = Atom.family((key: string) => {
    const environmentIds = JSON.parse(key) as ReadonlyArray<EnvironmentId>;
    return Atom.readable(
      (get): HubMergedInsightsLive => {
        const insights: HubInsights[] = [];
        let error: string | null = null;
        let isPending = false;
        for (const environmentId of environmentIds) {
          const result = get(hubInsights({ environmentId, input: {} }));
          isPending ||= result.waiting;
          if (result._tag === "Failure" && error === null) {
            error = formatMergeError(result.cause);
          }
          const value = Option.getOrNull(AsyncResult.value(result));
          if (value !== null) insights.push(value);
        }
        return { insights, error, isPending };
      },
      (refresh) => {
        for (const environmentId of environmentIds) {
          refresh(hubInsights({ environmentId, input: {} }));
        }
      },
    ).pipe(Atom.withLabel(`hub-merged-insights:${key}`));
  });
  const empty = Atom.make(EMPTY_INSIGHTS).pipe(Atom.withLabel("hub-merged-insights:empty"));
  return { family, empty };
}

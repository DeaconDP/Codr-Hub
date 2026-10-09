import type { EnvironmentId, HubMergedProjectView, HubSnapshot } from "@t3tools/contracts";
import { mergeHubProjectViews } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

export type HubMergedProjectsLive = {
  readonly projects: ReadonlyArray<HubMergedProjectView>;
  /** First successful snapshot, for strategy labels if the chosen env is down. */
  readonly anySnapshot: HubSnapshot | null;
  /** First failure. Others may still have answered — this is not fatal. */
  readonly error: string | null;
  readonly isPending: boolean;
};

const EMPTY_MERGED: HubMergedProjectsLive = {
  projects: [],
  anySnapshot: null,
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
 * React cannot subscribe to a variable-length atom list, so Hub-eligible
 * `hubLive` reads fan out inside one derived atom keyed by environment ids.
 */
export function createHubMergedProjectsAtomFamily(
  hubLive: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: Record<string, never>;
  }) => Atom.Atom<AsyncResult.AsyncResult<HubSnapshot, unknown>>,
) {
  const family = Atom.family((key: string) =>
    Atom.make((get): HubMergedProjectsLive => {
      const environmentIds = JSON.parse(key) as ReadonlyArray<EnvironmentId>;
      const snapshots: HubSnapshot[] = [];
      let error: string | null = null;
      let isPending = false;
      for (const environmentId of environmentIds) {
        const result = get(hubLive({ environmentId, input: {} }));
        isPending ||= result.waiting;
        if (result._tag === "Failure" && error === null) {
          error = formatMergeError(result.cause);
        }
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value !== null) snapshots.push(value);
      }
      return {
        projects: mergeHubProjectViews(snapshots),
        anySnapshot: snapshots[0] ?? null,
        error,
        isPending,
      };
    }).pipe(Atom.withLabel(`hub-merged-projects:${key}`)),
  );
  const empty = Atom.make(EMPTY_MERGED).pipe(Atom.withLabel("hub-merged-projects:empty"));
  return { family, empty };
}

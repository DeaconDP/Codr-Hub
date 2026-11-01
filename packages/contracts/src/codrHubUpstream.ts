/**
 * "Update from T3 Code": merge `upstream/main` into the running source checkout
 * and push it to `origin`, where fleet parents fast-forward from.
 *
 * @module codrHubUpstream
 */
import * as Schema from "effect/Schema";

export const HubUpstreamStatusInput = Schema.Struct({});
export type HubUpstreamStatusInput = typeof HubUpstreamStatusInput.Type;

export const HubUpstreamStatus = Schema.Union([
  Schema.TaggedStruct("Unavailable", {
    reason: Schema.String,
    checkedAtMs: Schema.Number,
  }),
  Schema.TaggedStruct("Available", {
    /** `null` when HEAD is detached. */
    branch: Schema.NullOr(Schema.String),
    /** Commits on `upstream/main` not in HEAD. */
    behind: Schema.Number,
    /** Commits in HEAD not on `upstream/main` (the fork's own work). */
    ahead: Schema.Number,
    /** No tracked or untracked changes. */
    clean: Schema.Boolean,
    /** A merge, rebase, cherry-pick or revert is unfinished. */
    operationInProgress: Schema.Boolean,
    checkedAtMs: Schema.Number,
  }),
]);
export type HubUpstreamStatus = typeof HubUpstreamStatus.Type;

export const HubUpstreamMergeInput = Schema.Struct({});
export type HubUpstreamMergeInput = typeof HubUpstreamMergeInput.Type;

export const HubUpstreamMergeResult = Schema.Union([
  Schema.TaggedStruct("UpToDate", {}),
  Schema.TaggedStruct("Merged", {
    merged: Schema.Number,
    branch: Schema.String,
    /** `null` when the push succeeded; the merge stays committed locally otherwise. */
    pushError: Schema.NullOr(Schema.String),
  }),
  /** The merge was aborted; the checkout is back where it started. */
  Schema.TaggedStruct("Conflict", {
    files: Schema.Array(Schema.String),
  }),
]);
export type HubUpstreamMergeResult = typeof HubUpstreamMergeResult.Type;

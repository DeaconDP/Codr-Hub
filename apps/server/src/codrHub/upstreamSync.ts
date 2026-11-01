/**
 * "Update from T3 Code": merges `upstream/main` into the running server's own
 * source checkout and pushes the result to `origin`. Fleet parents on every
 * node already fast-forward from `origin` and restart when idle
 * (`scripts/codr-hub-fleet/`), so pushing is the whole fan-out.
 *
 * Never leaves the checkout mid-merge: a conflict is aborted and reported.
 *
 * @module codrHub/upstreamSync
 */
import { HubError, type HubUpstreamMergeResult, type HubUpstreamStatus } from "@t3tools/contracts";
import type * as Duration from "effect/Duration";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import { ProcessRunner, layer as ProcessRunnerLayer } from "../processRunner.ts";
import { GIT_GLANCE_ARGS, parseGitGlance } from "./gitGlance.ts";

export const UPSTREAM_REMOTE = "upstream";
export const UPSTREAM_REF = "upstream/main";

const IN_PROGRESS_MARKERS = [
  "MERGE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
] as const;

type Requirements = ProcessRunner | FileSystem.FileSystem | Path.Path;

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

const run = (cwd: string, args: ReadonlyArray<string>, timeout: Duration.Input = "30 seconds") =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner;
    // No credential prompts: a server has no terminal to answer them.
    return yield* runner.run({
      command: "git",
      args,
      cwd,
      timeout,
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
  }).pipe(Effect.mapError((cause) => new HubError({ message: `git ${args[0]} failed.`, cause })));

const runOk = (cwd: string, args: ReadonlyArray<string>, timeout?: Duration.Input) =>
  run(cwd, args, timeout).pipe(
    Effect.flatMap((out) =>
      out.code === 0
        ? Effect.succeed(out.stdout.trim())
        : Effect.fail(
            new HubError({
              message: `git ${args.join(" ")}: ${firstLine(out.stderr) || `exit ${out.code}`}`,
            }),
          ),
    ),
  );

/** git push opens stderr with "To <url>"; the useful line names the rejection. */
const pushFailure = (stderr: string, code: number | null) =>
  stderr
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /rejected|error|fatal/i.test(line)) ??
  (firstLine(stderr) || `git push exit ${code}`);

type Checkout =
  | { readonly _tag: "Unavailable"; readonly reason: string }
  | { readonly _tag: "Checkout"; readonly root: string; readonly gitDir: string };

/** The checkout containing `startDir`, if it is a git checkout with an `upstream` remote. */
const locate = Effect.fnUntraced(function* (startDir: string) {
  const top = yield* run(startDir, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (top === null || top.code !== 0) {
    const checkout: Checkout = {
      _tag: "Unavailable",
      reason: "This server is not running from a git source checkout.",
    };
    return checkout;
  }
  const [root = "", gitDir = ""] = top.stdout.trim().split("\n");
  const remote = yield* run(root, ["remote", "get-url", UPSTREAM_REMOTE]);
  if (remote.code !== 0) {
    const checkout: Checkout = {
      _tag: "Unavailable",
      reason: `The checkout has no "${UPSTREAM_REMOTE}" remote. Add it with: git remote add ${UPSTREAM_REMOTE} https://github.com/pingdotgg/t3code.git`,
    };
    return checkout;
  }
  const checkout: Checkout = { _tag: "Checkout", root, gitDir };
  return checkout;
});

const operationInProgress = Effect.fnUntraced(function* (gitDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const marker of IN_PROGRESS_MARKERS) {
    const exists = yield* fs
      .exists(path.join(gitDir, marker))
      .pipe(
        Effect.mapError((cause) => new HubError({ message: "Could not read git state.", cause })),
      );
    if (exists) return true;
  }
  return false;
});

const fetchUpstream = (root: string) =>
  runOk(root, ["fetch", "--quiet", UPSTREAM_REMOTE], "2 minutes").pipe(
    Effect.mapError(
      (error) => new HubError({ message: `Could not fetch ${UPSTREAM_REMOTE}: ${error.message}` }),
    ),
  );

const aheadBehind = Effect.fnUntraced(function* (root: string) {
  const counts = yield* runOk(root, [
    "rev-list",
    "--left-right",
    "--count",
    `HEAD...${UPSTREAM_REF}`,
  ]);
  const [ahead = "0", behind = "0"] = counts.split(/\s+/);
  return { ahead: Number(ahead) || 0, behind: Number(behind) || 0 };
});

const inspect = Effect.fnUntraced(function* (checkout: Extract<Checkout, { _tag: "Checkout" }>) {
  const glance = parseGitGlance(yield* runOk(checkout.root, GIT_GLANCE_ARGS));
  const counts = yield* aheadBehind(checkout.root);
  return {
    _tag: "Available" as const,
    branch: glance.branch,
    clean: !glance.dirty,
    operationInProgress: yield* operationInProgress(checkout.gitDir),
    ...counts,
  };
});

export interface UpstreamSync {
  /** Fetches `upstream` and reports how far the checkout is from `upstream/main`. */
  readonly status: () => Effect.Effect<HubUpstreamStatus, HubError, Requirements>;
  /** Merges `upstream/main` and pushes to `origin`; aborts and lists files on conflict. */
  readonly merge: () => Effect.Effect<HubUpstreamMergeResult, HubError, Requirements>;
}

/** Operations on one checkout are serialized; `startDir` is any path inside it. */
export const makeUpstreamSync = (startDir: string): UpstreamSync => {
  const lock = Semaphore.makeUnsafe(1);

  const status = () =>
    lock.withPermit(
      Effect.gen(function* () {
        const checkedAtMs = yield* Clock.currentTimeMillis;
        const checkout = yield* locate(startDir);
        if (checkout._tag === "Unavailable") {
          return { _tag: "Unavailable", reason: checkout.reason, checkedAtMs } as const;
        }
        yield* fetchUpstream(checkout.root);
        return { ...(yield* inspect(checkout)), checkedAtMs };
      }),
    );

  const merge = () =>
    lock.withPermit(
      Effect.gen(function* () {
        const checkout = yield* locate(startDir);
        if (checkout._tag === "Unavailable") {
          return yield* new HubError({ message: checkout.reason });
        }
        const { root } = checkout;
        yield* fetchUpstream(root);
        const state = yield* inspect(checkout);
        if (state.operationInProgress) {
          return yield* new HubError({
            message: `The checkout has an unfinished git operation. Finish or abort it in ${root} first.`,
          });
        }
        if (!state.clean) {
          return yield* new HubError({
            message: `The checkout has uncommitted changes. Commit or stash them in ${root} first.`,
          });
        }
        if (state.branch === null) {
          return yield* new HubError({ message: "The checkout is not on a branch." });
        }
        if (state.behind === 0) return { _tag: "UpToDate" } as const;

        const merged = yield* run(root, ["merge", "--no-edit", UPSTREAM_REF], "5 minutes");
        if (merged.code !== 0) {
          if (yield* operationInProgress(checkout.gitDir)) {
            const files = yield* runOk(root, ["diff", "--name-only", "--diff-filter=U"]);
            yield* runOk(root, ["merge", "--abort"]);
            return {
              _tag: "Conflict",
              files: files.split("\n").filter((file) => file !== ""),
            } as const;
          }
          return yield* new HubError({
            message: `git merge ${UPSTREAM_REF}: ${firstLine(merged.stderr) || firstLine(merged.stdout) || `exit ${merged.code}`}`,
          });
        }

        // No force: if origin moved, the merge stays local and the owner pushes later.
        const pushed = yield* run(root, ["push", "origin", state.branch], "2 minutes");
        return {
          _tag: "Merged",
          merged: state.behind,
          branch: state.branch,
          pushError: pushed.code === 0 ? null : pushFailure(pushed.stderr, pushed.code),
        } as const;
      }),
    );

  return { status, merge };
};

const ownCheckout = makeUpstreamSync(import.meta.dirname);

/**
 * The checkout this server module was loaded from; unavailable in packaged builds.
 * Supplies its own `ProcessRunner`, which the WebSocket layer does not carry.
 */
export const upstreamSync = {
  status: () => ownCheckout.status().pipe(Effect.provide(ProcessRunnerLayer)),
  merge: () => ownCheckout.merge().pipe(Effect.provide(ProcessRunnerLayer)),
};

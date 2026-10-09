/** Subscription pacing owners live on separate git refs, outside portfolio history. */
import * as NodeCrypto from "node:crypto";

import { HubError, TrimmedNonEmptyString, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ProcessRunner } from "../processRunner.ts";
import type { PortfolioPaths } from "./portfolioStore.ts";

const OWNER_REF_PREFIX = "refs/heads/codr-hub-quota/";
const LOCAL_REF_PREFIX = "refs/codr-hub-quota/";
const KEY_PATTERN = /^[a-f0-9]{64}$/;
const OBJECT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

const Owner = Schema.Struct({
  version: Schema.Literal(1),
  nodeId: TrimmedNonEmptyString,
  nodeName: TrimmedNonEmptyString,
});
export type QuotaOwner = typeof Owner.Type;
const decodeOwner = Schema.decodeUnknownEffect(Schema.fromJsonString(Owner));
const decodeNodeId = Schema.decodeUnknownEffect(TrimmedNonEmptyString);
const validateOwner = Schema.decodeEffect(Owner);
const encodeOwner = Schema.encodeEffect(Schema.fromJsonString(Owner));

/** Instance IDs differ between machines. Never put account emails in git. */
export function accountKey(provider: Pick<ServerProvider, "driver" | "auth">): string | null {
  const email = provider.auth.email?.trim().toLowerCase();
  if (provider.auth.status !== "authenticated" || !email) return null;
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([provider.driver, email]))
    .digest("hex");
}

/** Publish a stable identity without replacing a concurrent initializer's file. */
export const nodeIdentity = Effect.fnUntraced(
  function* (paths: PortfolioPaths) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(paths.root, "quota-node-id");
    if (!(yield* fs.exists(file))) {
      const crypto = yield* Crypto.Crypto;
      const temporary = yield* fs.makeTempFileScoped({
        directory: paths.root,
        prefix: ".quota-node-id-",
      });
      yield* fs.writeFileString(temporary, `${yield* crypto.randomUUIDv4}\n`);
      yield* fs.link(temporary, file).pipe(
        Effect.catchIf(
          (cause) => cause.reason._tag === "AlreadyExists",
          () => Effect.void,
        ),
      );
    }
    return yield* decodeNodeId((yield* fs.readFileString(file)).trim());
  },
  Effect.scoped,
  Effect.mapError(
    (cause) =>
      new HubError({ message: "Could not read or create the quota node identity.", cause }),
  ),
);

const git = Effect.fnUntraced(
  function* (paths: PortfolioPaths, args: ReadonlyArray<string>, stdin?: string) {
    const runner = yield* ProcessRunner;
    return yield* runner.run({
      command: "git",
      cwd: paths.portfolioDir,
      args,
      stdin,
      timeout: "30 seconds",
    });
  },
  Effect.mapError(
    (cause) =>
      new HubError({
        message: "Could not contact the portfolio remote for quota ownership.",
        cause,
      }),
  ),
);

const gitOk = Effect.fnUntraced(function* (
  paths: PortfolioPaths,
  args: ReadonlyArray<string>,
  stdin?: string,
) {
  const result = yield* git(paths, args, stdin);
  if (result.code !== 0)
    return yield* new HubError({
      message: "Could not verify quota ownership on the portfolio remote. Check access and retry.",
    });
  return result.stdout.trim();
});

const ownerRef = (key: string) => {
  if (!KEY_PATTERN.test(key))
    return Effect.fail(new HubError({ message: "Invalid subscription quota key." }));
  return Effect.succeed(`${OWNER_REF_PREFIX}${key}`);
};

const readRecord = Effect.fnUntraced(function* (paths: PortfolioPaths, oid: string) {
  if (!OBJECT_PATTERN.test(oid))
    return yield* new HubError({ message: "Invalid remote quota ownership object." });
  yield* gitOk(paths, ["fetch", "--quiet", "--no-tags", "origin", oid]);
  const json = yield* gitOk(paths, ["show", `${oid}:owner.json`]);
  return yield* decodeOwner(json).pipe(
    Effect.mapError(
      (cause) =>
        new HubError({
          message: "The remote quota ownership record is unreadable; it was left unchanged.",
          cause,
        }),
    ),
  );
});

const remoteRefs = Effect.fnUntraced(function* (paths: PortfolioPaths, pattern: string) {
  const listing = yield* gitOk(paths, ["ls-remote", "--refs", "origin", pattern]);
  if (listing === "") return [];
  const entries: Array<{ oid: string; ref: string }> = [];
  for (const line of listing.split(/\r?\n/)) {
    const [oid, ref] = line.split("\t");
    if (
      !oid ||
      !ref ||
      !OBJECT_PATTERN.test(oid) ||
      !ref.startsWith(OWNER_REF_PREFIX) ||
      !KEY_PATTERN.test(ref.slice(OWNER_REF_PREFIX.length))
    ) {
      return yield* new HubError({
        message: "The remote quota ownership refs are invalid; they were left unchanged.",
      });
    }
    entries.push({ oid, ref });
  }
  return entries;
});

const readOwner = Effect.fnUntraced(function* (paths: PortfolioPaths, ref: string) {
  const [entry] = yield* remoteRefs(paths, ref);
  return entry === undefined
    ? null
    : { oid: entry.oid, owner: yield* readRecord(paths, entry.oid) };
});

const localPrefix = Effect.fnUntraced(function* (paths: PortfolioPaths) {
  const remote = yield* gitOk(paths, ["remote", "get-url", "origin"]);
  return `${LOCAL_REF_PREFIX}${NodeCrypto.createHash("sha256").update(remote).digest("hex")}/`;
});

/** One atomic creation wins. Existing owners never expire or get replaced here. */
export const claim = Effect.fnUntraced(function* (
  paths: PortfolioPaths,
  key: string,
  owner: QuotaOwner,
) {
  const ref = yield* ownerRef(key);
  yield* validateOwner(owner).pipe(
    Effect.mapError((cause) => new HubError({ message: "Invalid quota owner identity.", cause })),
  );
  const localRef = `${yield* localPrefix(paths)}${key}`;
  const existing = yield* readOwner(paths, ref);
  if (existing !== null) {
    yield* gitOk(
      paths,
      existing.owner.nodeId === owner.nodeId
        ? ["update-ref", localRef, existing.oid]
        : ["update-ref", "-d", localRef],
    );
    return existing.owner;
  }
  const json = yield* encodeOwner(owner).pipe(
    Effect.mapError(
      (cause) => new HubError({ message: "Could not encode the quota owner.", cause }),
    ),
  );
  const blob = yield* gitOk(paths, ["hash-object", "-w", "--stdin"], `${json}\n`);
  const tree = yield* gitOk(paths, ["mktree"], `100644 blob ${blob}\towner.json\n`);
  const commit = yield* gitOk(paths, [
    "-c",
    "commit.gpgsign=false",
    "commit-tree",
    tree,
    "-m",
    "Codr-Hub quota owner",
  ]);
  // Record the intent before the network mutation, so restart can drain an
  // ambiguous push even when its reply or the following launch never arrived.
  yield* gitOk(paths, ["update-ref", localRef, commit]);
  const pushed = yield* git(paths, [
    "push",
    "--quiet",
    "--porcelain",
    "--no-follow-tags",
    `--force-with-lease=${ref}:`,
    "origin",
    `${commit}:${ref}`,
  ]);
  if (pushed.code === 0) return owner;
  // A competing node may have won, or our push may have landed before its reply failed.
  const winner = yield* readOwner(paths, ref);
  if (winner !== null) {
    if (winner.owner.nodeId !== owner.nodeId) yield* gitOk(paths, ["update-ref", "-d", localRef]);
    return winner.owner;
  }
  return yield* new HubError({
    message:
      "Could not claim subscription pacing ownership. Check portfolio remote access and retry.",
  });
});

/** Call only after stopping this node's autopilot and draining its launched work. */
export const releaseOwned = Effect.fnUntraced(function* (paths: PortfolioPaths, nodeId: string) {
  const prefix = yield* localPrefix(paths);
  const local = yield* gitOk(paths, ["for-each-ref", "--format=%(refname)", prefix]);
  if (local === "") return 0;
  const entries = yield* remoteRefs(paths, `${OWNER_REF_PREFIX}*`);
  let released = 0;
  for (const { ref, oid } of entries) {
    const owner = yield* readRecord(paths, oid);
    if (owner.nodeId !== nodeId) continue;
    yield* gitOk(paths, [
      "push",
      "--quiet",
      "--porcelain",
      "--no-follow-tags",
      `--force-with-lease=${ref}:${oid}`,
      "origin",
      `:${ref}`,
    ]);
    released += 1;
  }
  for (const ref of local.split(/\r?\n/)) yield* gitOk(paths, ["update-ref", "-d", ref]);
  return released;
});

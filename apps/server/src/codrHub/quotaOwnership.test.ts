import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as Store from "./portfolioStore.ts";
import * as Quota from "./quotaOwnership.ts";

const account = (email: string, driver = "codex"): Pick<ServerProvider, "driver" | "auth"> => ({
  driver: ProviderDriverKind.make(driver),
  auth: { status: "authenticated", email },
});
const key = Quota.accountKey(account("shared@example.test"))!;

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "codr-hub-quota-" });
  const remote = path.join(root, "remote.git");
  yield* fs.makeDirectory(remote);
  expect((yield* Store.git(remote, ["init", "--quiet", "--bare", "-b", "main"])).code).toBe(0);
  const nodes = yield* Effect.forEach(["steve", "edgar"], (name) =>
    Effect.gen(function* () {
      const paths = Store.portfolioPaths(path, path.join(root, name));
      yield* Store.ensurePortfolioRepo(paths);
      yield* Store.setRemote(paths, remote);
      const id = yield* Quota.nodeIdentity(paths);
      return { paths, owner: { version: 1 as const, nodeId: id, nodeName: "Same display name" } };
    }),
  );
  const [steve, edgar] = nodes;
  if (!steve || !edgar) return yield* Effect.die("Expected two nodes");
  return { root, remote, steve, edgar };
});

describe("quota account identity", () => {
  it("shares a key across instance-independent normalized emails, without storing the email", () => {
    expect(Quota.accountKey(account(" Shared@Example.Test "))).toBe(key);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(Quota.accountKey(account("other@example.test"))).not.toBe(key);
    expect(Quota.accountKey(account("shared@example.test", "claudeAgent"))).not.toBe(key);
    expect(
      Quota.accountKey({
        driver: ProviderDriverKind.make("codex"),
        auth: { status: "unknown", email: "shared@example.test" },
      }),
    ).toBeNull();
    expect(
      Quota.accountKey({
        driver: ProviderDriverKind.make("codex"),
        auth: { status: "authenticated" },
      }),
    ).toBeNull();
  });
});

it.layer(NodeServices.layer)("quota ownership git", (it) => {
  it.effect("gives simultaneous contenders one owner even when their display names match", () =>
    Effect.gen(function* () {
      const { remote, steve, edgar } = yield* fixture;
      const owners = yield* Effect.all(
        [Quota.claim(steve.paths, key, steve.owner), Quota.claim(edgar.paths, key, edgar.owner)],
        { concurrency: "unbounded" },
      );
      expect(steve.owner.nodeId).not.toBe(edgar.owner.nodeId);
      expect(owners[0]).toEqual(owners[1]);
      expect(
        (yield* Store.git(remote, ["for-each-ref", "--format=%(refname)"])).stdout
          .trim()
          .split("\n"),
      ).toHaveLength(1);
      const body = (yield* Store.git(remote, [
        "show",
        `refs/heads/codr-hub-quota/${key}:owner.json`,
      ])).stdout;
      expect(body).not.toContain("shared@example.test");
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("preserves ownership across restart and allows handover only after release", () =>
    Effect.gen(function* () {
      const { steve, edgar } = yield* fixture;
      expect(yield* Quota.claim(steve.paths, key, steve.owner)).toEqual(steve.owner);
      expect(yield* Quota.nodeIdentity(steve.paths)).toBe(steve.owner.nodeId);
      expect(yield* Quota.claim(edgar.paths, key, edgar.owner)).toEqual(steve.owner);
      expect(yield* Quota.releaseOwned(edgar.paths, edgar.owner.nodeId)).toBe(0);
      expect(yield* Quota.releaseOwned(steve.paths, steve.owner.nodeId)).toBe(1);
      expect(yield* Quota.claim(edgar.paths, key, edgar.owner)).toEqual(edgar.owner);
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("recovers an ownership push whose reply was lost before any launch", () =>
    Effect.gen(function* () {
      const { steve, edgar } = yield* fixture;
      const runner = yield* ProcessRunner.ProcessRunner;
      const disconnected: ProcessRunner.ProcessRunner["Service"] = {
        run: (input) =>
          input.args[0] === "push"
            ? runner.run(input).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ProcessRunner.ProcessTimeoutError({
                      command: input.command,
                      argumentCount: input.args.length,
                      cwd: input.cwd,
                      timeoutMs: 30_000,
                    }),
                  ),
                ),
              )
            : runner.run(input),
      };
      expect(
        (yield* Quota.claim(steve.paths, key, steve.owner).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, disconnected),
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      expect(yield* Quota.claim(edgar.paths, key, edgar.owner)).toEqual(steve.owner);
      expect(yield* Quota.releaseOwned(steve.paths, steve.owner.nodeId)).toBe(1);
      expect(yield* Quota.claim(edgar.paths, key, edgar.owner)).toEqual(edgar.owner);
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("does not delete a replacement owner when release races with handover", () =>
    Effect.gen(function* () {
      const { steve, edgar } = yield* fixture;
      yield* Quota.claim(steve.paths, key, steve.owner);
      const runner = yield* ProcessRunner.ProcessRunner;
      let replaced = false;
      const interleaved: ProcessRunner.ProcessRunner["Service"] = {
        run: (input) =>
          Effect.gen(function* () {
            if (!replaced && input.args[0] === "push") {
              replaced = true;
              yield* Quota.releaseOwned(steve.paths, steve.owner.nodeId).pipe(
                Effect.provideService(ProcessRunner.ProcessRunner, runner),
                Effect.orDie,
              );
              yield* Quota.claim(edgar.paths, key, edgar.owner).pipe(
                Effect.provideService(ProcessRunner.ProcessRunner, runner),
                Effect.orDie,
              );
            }
            return yield* runner.run(input);
          }),
      };
      expect(
        (yield* Quota.releaseOwned(steve.paths, steve.owner.nodeId).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, interleaved),
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      expect(replaced).toBe(true);
      expect(yield* Quota.claim(steve.paths, key, steve.owner)).toEqual(edgar.owner);
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("keeps independent accounts independent and leaves portfolio history unchanged", () =>
    Effect.gen(function* () {
      const { remote, steve, edgar } = yield* fixture;
      yield* Store.writeHubFile(steve.paths, Store.EMPTY_HUB_FILE);
      yield* Store.commitPortfolio(steve.paths, "Seed portfolio");
      yield* Store.syncPortfolio(steve.paths);
      const head = (yield* Store.git(remote, ["rev-parse", "main"])).stdout;
      const other = Quota.accountKey(account("other@example.test"))!;
      expect(yield* Quota.claim(steve.paths, key, steve.owner)).toEqual(steve.owner);
      expect(yield* Quota.claim(edgar.paths, other, edgar.owner)).toEqual(edgar.owner);
      yield* Store.syncPortfolio(steve.paths);
      expect((yield* Store.git(remote, ["rev-parse", "main"])).stdout).toBe(head);
      expect((yield* Store.git(steve.paths.portfolioDir, ["status", "--porcelain"])).stdout).toBe(
        "",
      );
      expect(yield* Quota.releaseOwned(steve.paths, steve.owner.nodeId)).toBe(1);
      expect(yield* Quota.claim(steve.paths, other, steve.owner)).toEqual(edgar.owner);
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("fails closed while the remote is offline and retains the owner for recovery", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { remote, steve, edgar } = yield* fixture;
      yield* Quota.claim(steve.paths, key, steve.owner);
      yield* fs.rename(remote, `${remote}.offline`);
      expect((yield* Effect.result(Quota.claim(steve.paths, key, steve.owner)))._tag).toBe(
        "Failure",
      );
      expect((yield* Effect.result(Quota.claim(edgar.paths, key, edgar.owner)))._tag).toBe(
        "Failure",
      );
      expect((yield* Effect.result(Quota.releaseOwned(steve.paths, steve.owner.nodeId)))._tag).toBe(
        "Failure",
      );
      yield* fs.rename(`${remote}.offline`, remote);
      expect(yield* Quota.claim(edgar.paths, key, edgar.owner)).toEqual(steve.owner);
      expect(yield* Quota.releaseOwned(steve.paths, steve.owner.nodeId)).toBe(1);
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect(
    "uses one stable identity for concurrent initializers and refuses a corrupt identity",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "codr-hub-quota-id-" });
        const paths = Store.portfolioPaths(path, root);
        yield* Store.ensurePortfolioRepo(paths);
        const ids = yield* Effect.all([Quota.nodeIdentity(paths), Quota.nodeIdentity(paths)], {
          concurrency: "unbounded",
        });
        expect(ids[0]).toBe(ids[1]);
        const file = path.join(paths.root, "quota-node-id");
        yield* fs.writeFileString(file, "\n");
        expect((yield* Effect.result(Quota.nodeIdentity(paths)))._tag).toBe("Failure");
        expect(yield* fs.readFileString(file)).toBe("\n");
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );
});

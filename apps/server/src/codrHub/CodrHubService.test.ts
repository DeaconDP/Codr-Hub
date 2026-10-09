import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Hub from "./CodrHubService.ts";
import * as Store from "./portfolioStore.ts";

const serviceLayer = (baseDir: string) =>
  Hub.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), baseDir),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            }),
        }),
        Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
      ),
    ),
  );

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "codr-hub-service-" });
  const baseDir = path.join(root, "steve");
  const paths = Store.portfolioPaths(path, path.join(baseDir, "userdata"));
  yield* Store.ensurePortfolioRepo(paths);
  yield* Store.writeHubFile(paths, Store.EMPTY_HUB_FILE);
  yield* Store.commitPortfolio(paths, "Seed portfolio");
  const remote = path.join(root, "remote.git");
  yield* fs.makeDirectory(remote);
  expect((yield* Store.git(remote, ["init", "--quiet", "--bare", "-b", "main"])).code).toBe(0);
  yield* Store.setRemote(paths, remote);
  yield* Store.syncPortfolio(paths);
  const peer = Store.portfolioPaths(path, path.join(root, "edgar"));
  yield* Store.ensurePortfolioRepo(peer);
  yield* Store.setRemote(peer, remote);
  yield* Store.syncPortfolio(peer);
  return { baseDir, paths, peer };
});

const snapshot = (hub: Hub.CodrHubService["Service"]) =>
  hub.subscribe().pipe(Stream.runHead, Effect.map(Option.getOrThrow));

it.layer(NodeServices.layer)("codr-hub mesh service", (it) => {
  it.effect("keeps simultaneous patches to the same project", () =>
    Effect.gen(function* () {
      const { baseDir, paths } = yield* fixture;
      yield* Effect.gen(function* () {
        const hub = yield* Hub.CodrHubService;
        yield* hub.upsertProject({ name: "Shared" });
        yield* Effect.all(
          [
            hub.upsertProject({ id: "shared", priority: "critical" }),
            hub.upsertProject({ id: "shared", notes: "Keep these notes" }),
          ],
          { concurrency: "unbounded" },
        );
        const [saved] = yield* Store.readProjects(paths);
        expect(saved?.priority).toBe("critical");
        expect(saved?.notes).toBe("Keep these notes");
        expect((yield* snapshot(hub)).projects[0]?.project).toEqual(saved);
      }).pipe(Effect.provide(serviceLayer(baseDir)));
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("keeps concurrent strategy and settings edits to hub.json", () =>
    Effect.gen(function* () {
      const { baseDir, paths } = yield* fixture;
      yield* Effect.gen(function* () {
        const hub = yield* Hub.CodrHubService;
        const strategy = [{ id: "ship", title: "Ship v1", notes: "" }];
        yield* Effect.all(
          [hub.setStrategy({ strategy }), hub.updateSettings({ paceTargetPercent: 90 })],
          { concurrency: "unbounded" },
        );
        const saved = yield* Store.readHubFile(paths);
        expect(saved.strategy).toEqual(strategy);
        expect(saved.settings.paceTargetPercent).toBe(90);
      }).pipe(Effect.provide(serviceLayer(baseDir)));
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("applies an edit queued during sync to the freshly loaded portfolio", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { baseDir, paths, peer } = yield* fixture;
      const reloadStarted = yield* Deferred.make<void>();
      const releaseReload = yield* Deferred.make<void>();
      const editStarted = yield* Deferred.make<void>();
      let pauseReload = false;
      const controlledFs: FileSystem.FileSystem = {
        ...fs,
        readFileString: Effect.fnUntraced(function* (file: string, encoding?: string) {
          const contents = yield* fs.readFileString(file, encoding);
          if (pauseReload && file === paths.hubFile) {
            pauseReload = false;
            yield* Deferred.succeed(reloadStarted, undefined);
            yield* Deferred.await(releaseReload);
          }
          return contents;
        }),
      };
      yield* Effect.gen(function* () {
        const hub = yield* Hub.CodrHubService;
        yield* hub.upsertProject({ name: "Shared" });
        yield* hub.sync({});
        yield* Store.syncPortfolio(peer);
        const [shared] = yield* Store.readProjects(peer);
        if (shared === undefined) return yield* Effect.die("Expected the shared project");
        yield* Store.writeProject(peer, { ...shared, notes: "Edgar's incoming notes" });
        yield* Store.commitPortfolio(peer, "Edgar edits notes");
        yield* Store.syncPortfolio(peer);
        pauseReload = true;
        const syncing = yield* hub.sync({}).pipe(Effect.forkChild);
        yield* Deferred.await(reloadStarted);
        const editing = yield* Deferred.succeed(editStarted, undefined).pipe(
          Effect.andThen(hub.upsertProject({ id: "shared", priority: "critical" })),
          Effect.forkChild,
        );
        yield* Deferred.await(editStarted);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseReload, undefined);
        expect((yield* Fiber.join(syncing)).lastError).toBeNull();
        yield* Fiber.join(editing);
        const [saved] = yield* Store.readProjects(paths);
        expect(saved?.notes).toBe("Edgar's incoming notes");
        expect(saved?.priority).toBe("critical");
        expect((yield* snapshot(hub)).projects[0]?.project).toEqual(saved);
      }).pipe(
        Effect.provide(serviceLayer(baseDir)),
        Effect.provideService(FileSystem.FileSystem, controlledFs),
      );
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("clears an old sync error when the owner removes the remote", () =>
    Effect.gen(function* () {
      const { baseDir, paths } = yield* fixture;
      yield* Effect.gen(function* () {
        const hub = yield* Hub.CodrHubService;
        const failed = yield* hub.sync({ remote: `${paths.root}/missing.git` });
        expect(failed.lastError).not.toBeNull();
        const cleared = yield* hub.sync({ remote: null });
        expect(cleared.remote).toBeNull();
        expect(cleared.lastError).toBeNull();
        expect(cleared.lastSyncAt).toBeNull();
        expect((yield* snapshot(hub)).sync).toEqual(cleared);
      }).pipe(Effect.provide(serviceLayer(baseDir)));
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("retains incoming edits when pull succeeds but push disconnects", () =>
    Effect.gen(function* () {
      const { baseDir, paths, peer } = yield* fixture;
      const runner = yield* ProcessRunner.ProcessRunner;
      let disconnect = false;
      let failedPushes = 0;
      const controlledRunner: ProcessRunner.ProcessRunner["Service"] = {
        run: (input) => {
          if (disconnect && input.cwd === paths.portfolioDir && input.args[0] === "push") {
            failedPushes += 1;
            return Effect.fail(
              new ProcessRunner.ProcessTimeoutError({
                command: input.command,
                argumentCount: input.args.length,
                cwd: input.cwd,
                timeoutMs: 30_000,
              }),
            );
          }
          return runner.run(input);
        },
      };
      yield* Effect.gen(function* () {
        const hub = yield* Hub.CodrHubService;
        yield* hub.upsertProject({ name: "Shared" });
        yield* hub.sync({});
        yield* Store.syncPortfolio(peer);
        const [shared] = yield* Store.readProjects(peer);
        if (shared === undefined) return yield* Effect.die("Expected the shared project");
        yield* Store.writeProject(peer, { ...shared, notes: "Incoming notes" });
        yield* Store.commitPortfolio(peer, "Edgar edits notes");
        yield* Store.syncPortfolio(peer);
        yield* hub.upsertProject({ id: "shared", priority: "critical" });
        disconnect = true;
        expect((yield* hub.sync({})).lastError).not.toBeNull();
        expect(failedPushes).toBe(1);
        disconnect = false;
        yield* hub.upsertProject({ id: "shared", category: "Utilities" });
        const [saved] = yield* Store.readProjects(paths);
        expect(saved?.notes).toBe("Incoming notes");
        expect(saved?.priority).toBe("critical");
        expect(saved?.category).toBe("Utilities");
        expect((yield* snapshot(hub)).projects[0]?.project).toEqual(saved);
        expect((yield* hub.sync({})).lastError).toBeNull();
        yield* Store.syncPortfolio(peer);
        expect(yield* Store.readProjects(peer)).toEqual([saved]);
      }).pipe(
        Effect.provide(serviceLayer(baseDir)),
        Effect.provideService(ProcessRunner.ProcessRunner, controlledRunner),
      );
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("refuses portfolio edits during a manual rebase", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir, paths, peer } = yield* fixture;
      yield* Effect.gen(function* () {
        const hub = yield* Hub.CodrHubService;
        yield* hub.upsertProject({ name: "Shared" });
        yield* hub.sync({});
        yield* Store.syncPortfolio(peer);
        const [shared] = yield* Store.readProjects(peer);
        if (shared === undefined) return yield* Effect.die("Expected the shared project");
        yield* Store.writeProject(peer, { ...shared, name: "Edgar's name" });
        yield* Store.commitPortfolio(peer, "Edgar renames project");
        yield* Store.syncPortfolio(peer);
        yield* hub.upsertProject({ id: "shared", name: "Steve's name" });
        yield* Store.git(paths.portfolioDir, ["fetch", "origin"]);
        expect((yield* Store.git(paths.portfolioDir, ["rebase", "origin/main"])).code).not.toBe(0);
        const file = path.join(paths.projectsDir, "shared.json");
        const before = yield* fs.readFileString(file);
        const result = yield* Effect.result(hub.upsertProject({ id: "shared", notes: "Blocked" }));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure.message).toContain("unfinished git operation");
        expect(yield* fs.readFileString(file)).toBe(before);
        expect(yield* fs.exists(path.join(paths.portfolioDir, ".git", "rebase-merge"))).toBe(true);
      }).pipe(Effect.provide(serviceLayer(baseDir)));
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );
});

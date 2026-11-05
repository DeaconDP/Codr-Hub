import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type {
  ApplicationStoredEvent,
  OrchestrationProjectShell,
  Project,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Hub from "./CodrHubService.ts";
import { ExternalT3Home } from "./externalT3Runs.ts";
import * as Store from "./portfolioStore.ts";

const serviceLayer = (
  baseDir: string,
  projects: Partial<ProjectService.ProjectService["Service"]> = {},
  applicationEvents: Stream.Stream<ApplicationStoredEvent> = Stream.never,
) =>
  Hub.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), baseDir),
        Layer.succeed(ExternalT3Home, baseDir),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
        Layer.mock(ProjectService.ProjectService)(projects),
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
        Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
          latestApplicationSequence: Effect.succeed(0),
          streamProjectedApplicationEvents: ({ project }) =>
            applicationEvents.pipe(Stream.map(project)),
        }),
      ),
    ),
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
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

/** Inserts into a migrated T3 projection database. */
const t3Rows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  let ordinal = 0;
  return {
    project: (id: string, title: string, workspaceRoot: string) =>
      sql`
        INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES (${id}, ${title}, ${workspaceRoot}, '[]',
          '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')
      `,
    thread: (id: string, projectId: string, archivedAt: string | null, deletedAt: string | null) =>
      sql`
        INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
           created_at, updated_at, archived_at, deleted_at, payload_json)
        VALUES (${id}, ${projectId}, ${id}, 'codex', 'full-access', 'default',
          '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', ${archivedAt}, ${deletedAt}, '{}')
      `,
    run: (threadId: string, instance: string, requestedAt: string, completedAt: string | null) =>
      sql`
        INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at,
           completed_at, payload_json)
        VALUES (${`run-${(ordinal += 1)}`}, ${threadId}, ${ordinal}, ${instance}, ${instance},
          'completed', ${requestedAt}, ${completedAt}, '{}')
      `,
  };
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

  it.effect("merges this-node stickyPort and launchCmd without wiping path", () =>
    Effect.gen(function* () {
      const { baseDir, paths } = yield* fixture;
      yield* Effect.gen(function* () {
        const hub = yield* Hub.CodrHubService;
        yield* hub.setNode({ nodeName: "Steve" });
        yield* hub.upsertProject({
          name: "Fleet",
          localPath: "/Users/steve/Fleet",
          previewUrl: "https://preview.example",
        });
        yield* hub.upsertProject({
          id: "fleet",
          stickyPort: 5173,
          launchCmd: "npm run dev",
        });
        const [saved] = yield* Store.readProjects(paths);
        expect(saved?.previewUrl).toBe("https://preview.example");
        expect(saved?.hosts.Steve).toEqual({
          path: "/Users/steve/Fleet",
          stickyPort: 5173,
          launchCmd: "npm run dev",
        });
        yield* hub.upsertProject({ id: "fleet", localPath: "/Users/steve/Fleet-2" });
        const [moved] = yield* Store.readProjects(paths);
        expect(moved?.hosts.Steve).toEqual({
          path: "/Users/steve/Fleet-2",
          stickyPort: 5173,
          launchCmd: "npm run dev",
        });
      }).pipe(Effect.provide(serviceLayer(baseDir)));
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("applies a batch upsert as one portfolio commit", () =>
    Effect.gen(function* () {
      const { baseDir, paths } = yield* fixture;
      yield* Effect.gen(function* () {
        const hub = yield* Hub.CodrHubService;
        yield* hub.upsertProject({ name: "Alpha" });
        const before = yield* Store.git(paths.portfolioDir, ["rev-list", "--count", "HEAD"]);
        yield* hub.upsertProjects({
          projects: [
            { id: "alpha", sortIndex: 1 },
            { name: "Beta", localPath: "/work/beta", sortIndex: 0, favorite: true },
          ],
        });
        const after = yield* Store.git(paths.portfolioDir, ["rev-list", "--count", "HEAD"]);
        expect(Number(after.stdout) - Number(before.stdout)).toBe(1);
        const saved = new Map((yield* Store.readProjects(paths)).map((p) => [p.id, p]));
        expect(saved.get("alpha")?.sortIndex).toBe(1);
        expect(saved.get("beta")).toMatchObject({ sortIndex: 0, favorite: true, autonomy: 0 });
        expect(Object.values(saved.get("beta")?.hosts ?? {})).toEqual([
          { path: "/work/beta", stickyPort: null, launchCmd: null },
        ]);
      }).pipe(Effect.provide(serviceLayer(baseDir)));
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("rejects the whole batch when one upsert is invalid", () =>
    Effect.gen(function* () {
      const { baseDir, paths } = yield* fixture;
      yield* Effect.gen(function* () {
        const hub = yield* Hub.CodrHubService;
        const result = yield* hub
          .upsertProjects({ projects: [{ name: "Gamma" }, { id: "missing", favorite: true }] })
          .pipe(Effect.flip);
        expect(result.message).toContain("missing");
        expect(yield* Store.readProjects(paths)).toEqual([]);
      }).pipe(Effect.provide(serviceLayer(baseDir)));
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("imports this node's T3 projects once", () =>
    Effect.gen(function* () {
      const { baseDir, paths } = yield* fixture;
      const shell = (title: string, workspaceRoot: string) =>
        ({ title, workspaceRoot, repositoryIdentity: null }) as OrchestrationProjectShell;
      const listShells = () =>
        Effect.succeed([shell("Alpha", "/work/alpha"), shell("Beta", "/work/beta")]);
      yield* Effect.gen(function* () {
        const hub = yield* Hub.CodrHubService;
        yield* hub.upsertProject({ name: "Alpha" });
        expect(yield* hub.importProjects({ source: "t3" })).toEqual({
          imported: 1,
          updated: 1,
          skipped: 0,
          created: 0,
        });
        expect(yield* hub.importProjects({ source: "t3" })).toEqual({
          imported: 0,
          updated: 0,
          skipped: 2,
          created: 0,
        });
        const saved = (yield* Store.readProjects(paths)).map((p) => [p.id, Object.values(p.hosts)]);
        expect(saved).toEqual([
          ["alpha", [{ path: "/work/alpha", stickyPort: null, launchCmd: null }]],
          ["beta", [{ path: "/work/beta", stickyPort: null, launchCmd: null }]],
        ]);
      }).pipe(Effect.provide(serviceLayer(baseDir, { listShells })));
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("syncs with T3 both ways on enable and on each T3 project event", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir, paths } = yield* fixture;
      const checkout = path.join(baseDir, "hub-only");
      yield* fs.makeDirectory(checkout, { recursive: true });
      const shell = (title: string, workspaceRoot: string) =>
        ({ title, workspaceRoot, repositoryIdentity: null }) as OrchestrationProjectShell;
      const shells = [shell("Alpha", "/work/alpha")];
      const created: Array<{ title: string; workspaceRoot: string }> = [];
      const events = yield* Queue.unbounded<ApplicationStoredEvent>();
      const projects: Partial<ProjectService.ProjectService["Service"]> = {
        listShells: () => Effect.sync(() => [...shells]),
        getByWorkspaceRoot: () => Effect.succeedNone,
        create: (input) =>
          Effect.sync(() => {
            created.push({ title: input.title, workspaceRoot: input.workspaceRoot });
            shells.push(shell(input.title, input.workspaceRoot));
            return { id: input.projectId, title: input.title } as Project;
          }),
      };
      yield* Effect.gen(function* () {
        const hub = yield* Hub.CodrHubService;
        yield* hub.upsertProject({ name: "Hub Only", localPath: checkout });
        expect((yield* snapshot(hub)).t3Sync?.enabled).toBe(false);

        yield* hub.setNode({ syncT3: true });
        const first = yield* hub.subscribe().pipe(
          Stream.filter((next) => next.t3Sync?.lastResult != null),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(first.t3Sync).toMatchObject({
          enabled: true,
          lastError: null,
          lastResult: { imported: 1, updated: 0, skipped: 0, created: 1 },
        });
        expect(created).toEqual([{ title: "Hub Only", workspaceRoot: checkout }]);
        expect((yield* Store.readNodeFile(paths)).syncT3).toBe(true);

        shells.push(shell("Beta", "/work/beta"));
        yield* Queue.offer(events, {
          aggregateKind: "project",
          aggregateId: "beta",
          type: "project.created",
          sequence: 1,
        } as unknown as ApplicationStoredEvent);
        const second = yield* hub.subscribe().pipe(
          // Project writes notify before the sync result lands; wait for the result.
          Stream.filter(
            (next) =>
              next.projects.some((view) => view.project.id === "beta") &&
              next.t3Sync?.lastResult !== first.t3Sync?.lastResult,
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(second.t3Sync?.lastResult).toEqual({
          imported: 1,
          updated: 0,
          skipped: 2,
          created: 0,
        });
        expect(created).toHaveLength(1);
        expect((yield* Store.readProjects(paths)).map((project) => project.id).toSorted()).toEqual([
          "alpha",
          "beta",
          "hub-only",
        ]);
      }).pipe(Effect.provide(serviceLayer(baseDir, projects, Stream.fromQueue(events))));
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("patches machine colours per node", () =>
    Effect.gen(function* () {
      const { baseDir, paths } = yield* fixture;
      yield* Effect.gen(function* () {
        const hub = yield* Hub.CodrHubService;
        yield* hub.updateSettings({ nodeColors: { Steve: "teal", Ada: "red" } });
        yield* hub.updateSettings({ nodeColors: { Ada: null } });
        expect((yield* Store.readHubFile(paths)).settings.nodeColors).toEqual({ Steve: "teal" });
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

  it.effect("applies board commands under the write lock and sweeps tasks on delete", () =>
    Effect.gen(function* () {
      const { baseDir, paths } = yield* fixture;
      yield* Effect.gen(function* () {
        const hub = yield* Hub.CodrHubService;
        yield* hub.upsertProject({ name: "Boarded" });
        const created = yield* hub.applyBoard({
          type: "create",
          projectId: "boarded",
          id: "card-1",
          title: "Ship board",
          column: "todo",
        });
        expect(created.tasks).toHaveLength(1);
        expect(created.tasks[0]?.title).toBe("Ship board");
        expect((yield* Store.readTasks(paths)).map((task) => task.id)).toEqual(["card-1"]);

        const moved = yield* hub.applyBoard({
          type: "move",
          projectId: "boarded",
          taskId: "card-1",
          toColumn: "in_progress",
          beforeTaskId: null,
          afterTaskId: null,
        });
        expect(moved.tasks[0]?.column).toBe("in_progress");
        expect(moved.revision).toBeGreaterThan(created.revision);

        const live = yield* hub
          .subscribeBoard("boarded")
          .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
        expect(live.tasks[0]?.column).toBe("in_progress");

        yield* hub.deleteProject({ id: "boarded" });
        expect(yield* Store.readTasks(paths)).toEqual([]);
      }).pipe(Effect.provide(serviceLayer(baseDir)));
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("reports platform, commit and agent activity for this node's checkouts", () =>
    Effect.gen(function* () {
      const { baseDir } = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const game = path.join(baseDir, "game");
      const site = path.join(baseDir, "site");
      yield* fs.makeDirectory(game);
      yield* fs.makeDirectory(site);
      yield* fs.writeFileString(path.join(game, "Game.uproject"), "{}");
      yield* fs.writeFileString(path.join(site, "package.json"), "{}");
      const commit = ["-c", "user.name=Hub", "-c", "user.email=hub@example.com", "commit"];
      yield* Store.git(game, ["init", "--quiet", "-b", "main"]);
      yield* Store.git(game, ["add", "."]);
      yield* Store.git(game, [...commit, "--quiet", "-m", "one"]);
      yield* Store.git(game, [...commit, "--quiet", "--allow-empty", "-m", "two"]);
      // Real commits land after this, so they count in every window.
      yield* TestClock.setTime(Date.parse("2026-06-01T12:00:00.000Z"));
      // The Hub knows the checkout by a symlink; T3 stores the real path.
      const links = path.join(baseDir, "links");
      yield* fs.makeDirectory(links);
      yield* fs.symlink(game, path.join(links, "game"));
      const scratch = path.join(baseDir, "scratch");
      yield* fs.makeDirectory(scratch);
      const externalDb = path.join(baseDir, ".t3", "userdata", "statev2.sqlite");
      yield* fs.makeDirectory(path.dirname(externalDb), { recursive: true });
      yield* Effect.gen(function* () {
        yield* runMigrations();
        const t3 = yield* t3Rows;
        yield* t3.project("ext-game", "Game", game);
        yield* t3.project("ext-scratch", "", scratch);
        yield* t3.thread("ext", "ext-game", null, null);
        yield* t3.thread("ext-scratch", "ext-scratch", null, null);
        yield* t3.run(
          "ext",
          "claudeAgent_home",
          "2026-06-01T11:00:00.000Z",
          "2026-06-01T11:10:00.000Z",
        );
        yield* t3.run(
          "ext-scratch",
          "codex",
          "2026-05-20T09:00:00.000Z",
          "2026-05-20T09:01:00.000Z",
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: externalDb })));
      yield* Effect.gen(function* () {
        yield* runMigrations();
        const { project, thread, run } = yield* t3Rows;
        yield* project("t3-game", "Game", game);
        yield* project("t3-other", "Scratch", scratch);
        yield* thread("live", "t3-game", null, null);
        yield* thread("shelved", "t3-game", "2026-05-01T00:00:00.000Z", null);
        yield* thread("gone", "t3-game", null, "2026-05-01T00:00:00.000Z");
        yield* thread("elsewhere", "t3-other", null, null);
        yield* run("live", "codex", "2026-06-01T10:00:00.000Z", "2026-06-01T10:20:00.000Z");
        yield* run(
          "shelved",
          "claudeAgent_work",
          "2026-05-25T09:00:00.000Z",
          "2026-05-25T09:05:00.000Z",
        );
        yield* run("live", "codex", "2024-06-01T09:00:00.000Z", "2024-06-01T09:03:00.000Z");
        yield* run("gone", "codex", "2026-06-01T09:00:00.000Z", "2026-06-01T09:30:00.000Z");
        yield* run("elsewhere", "codex", "2026-06-01T09:00:00.000Z", "2026-06-01T09:30:00.000Z");

        const hub = yield* Hub.CodrHubService;
        yield* hub.upsertProjects({
          projects: [
            { name: "Game", localPath: path.join(links, "game"), tags: ["Web"] },
            { name: "Site", localPath: site },
            { name: "Gone", localPath: path.join(baseDir, "missing") },
          ],
        });
        const result = yield* hub.insights();
        const byId = new Map(result.projects.map((insight) => [insight.projectId, insight]));
        expect([...byId.keys()].toSorted()).toEqual(["game", "site"]);
        const gameInsight = byId.get("game");
        expect(gameInsight).toMatchObject({
          platform: "unreal",
          commits: { "24h": 2, "7d": 2, "1m": 2, "1y": 2, all: 2 },
          agent: {
            runs: { "24h": 2, "7d": 2, "14d": 3, "1y": 3, all: 4 },
            threads: { "24h": 2, "14d": 3, all: 3 },
            minutes: { "24h": 30, "14d": 35, all: 38 },
            lastRunAt: "2026-06-01T11:00:00.000Z",
            providers: [
              { provider: "codex", runs: { "24h": 1, all: 2 } },
              { provider: "claudeAgent", runs: { "24h": 1, all: 2 } },
            ],
          },
        });
        expect(gameInsight?.lastCommitAt).not.toBeNull();
        expect(gameInsight?.daily.filter((day) => day.runs > 0)).toEqual([
          { day: expect.any(String), commits: 0, runs: 1, minutes: 5 },
          { day: expect.any(String), commits: expect.any(Number), runs: 2, minutes: 30 },
        ]);
        expect(gameInsight?.daily.reduce((sum, day) => sum + day.commits, 0)).toBe(2);
        expect(byId.get("site")).toMatchObject({
          platform: "web",
          commits: { "24h": 0, all: 0 },
          lastCommitAt: null,
          agent: { runs: { all: 0 }, lastRunAt: null, providers: [] },
          daily: [],
        });
        expect(result.untracked).toMatchObject([
          {
            workspaceRoot: yield* fs.realPath(scratch),
            name: "Scratch",
            agent: { runs: { "7d": 1, all: 2 }, minutes: { all: 31 } },
          },
        ]);
      }).pipe(Effect.provide(serviceLayer(baseDir)));
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );
});

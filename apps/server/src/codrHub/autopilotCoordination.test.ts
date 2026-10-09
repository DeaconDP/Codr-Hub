import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  OrchestrationV2AppThread,
  HubError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstances from "../provider/Services/ProviderInstanceRegistry.ts";
import * as Providers from "../provider/Services/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Hub from "./CodrHubService.ts";
import * as Store from "./portfolioStore.ts";
import * as Quota from "./quotaOwnership.ts";

const provider = (id: string, now: number, usedPercent = 94): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated", email: "shared@example.test" },
  checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
  models: [
    { slug: "test-model", name: "Test", isCustom: false, isDefault: true, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    windows: [
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent,
        resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 6 * 3_600_000)),
        windowDurationMins: 7 * 24 * 60,
      },
    ],
    resetCredits: {
      availableCount: 2,
      nextExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 3_600_000)),
    },
  },
});

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "codr-hub-autopilot-" });
  const remote = path.join(root, "remote.git");
  yield* fs.makeDirectory(remote);
  expect((yield* Store.git(remote, ["init", "--quiet", "--bare", "-b", "main"])).code).toBe(0);
  const nodes = yield* Effect.forEach(["steve", "edgar"], (name) =>
    Effect.gen(function* () {
      const baseDir = path.join(root, name);
      const paths = Store.portfolioPaths(path, path.join(baseDir, "userdata"));
      yield* Store.ensurePortfolioRepo(paths);
      yield* Store.setRemote(paths, remote);
      return { baseDir, paths };
    }),
  );
  const [steve, edgar] = nodes;
  if (!steve || !edgar) return yield* Effect.die("Expected two nodes");
  return { remote, steve, edgar, now: yield* Clock.currentTimeMillis };
});

const nodeHarness = (baseDir: string, initialProviders: ReadonlyArray<ServerProvider>) => {
  let due: Effect.Effect<void, HubError> = Effect.void;
  let currentProviders = initialProviders;
  let probeFailure = false;
  let lostReply = false;
  let redemptions = 0;
  const calls: ThreadLaunch.ThreadLaunchInput[] = [];
  const shells = new Map<string, OrchestrationV2ThreadShell>();
  const unused = () => Effect.die("Unexpected provider operation");
  const instance = (p: ServerProvider): ProviderInstance => ({
    instanceId: p.instanceId,
    driverKind: p.driver,
    enabled: true,
    displayName: undefined,
    continuationIdentity: { driverKind: p.driver, continuationKey: p.instanceId },
    snapshot: {
      getSnapshot: Effect.succeed(p),
      refresh: Effect.succeed(p),
      streamChanges: Stream.empty,
      resolveMaintenance: unused,
      applyUsageLimits: () => Effect.void,
    },
    orchestrationAdapter: {
      instanceId: p.instanceId,
      driver: p.driver,
      getCapabilities: unused,
      planSelectionTransition: unused,
      openSession: unused,
    },
    textGeneration: {
      generateCommitMessage: unused,
      generatePrContent: unused,
      generateBranchName: unused,
      generateThreadTitle: unused,
    },
    consumeResetCredit: () =>
      Effect.sync(() => {
        redemptions += 1;
        return "reset" as const;
      }),
  });
  const launch: ThreadLaunch.ThreadLaunchService["Service"]["launch"] = (input) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      if (!input.threadId) return yield* Effect.die("Expected a durable launch ID");
      calls.push(input);
      const thread = OrchestrationV2AppThread.make({
        id: input.threadId,
        projectId: input.projectId,
        title: input.title,
        providerInstanceId: input.modelSelection.instanceId,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      });
      shells.set(thread.id, {
        ...thread,
        latestRunId: RunId.make(`run:${thread.id}`),
        activeRunId: RunId.make(`run:${thread.id}`),
        status: "running",
        pendingRuntimeRequest: null,
        latestVisibleMessage: null,
        latestUserMessageAt: now,
        hasActionableProposedPlan: false,
        pendingBackgroundTasks: [],
        providerInstanceHistory: [],
        itemCount: 0,
        visibleItemCount: 0,
      });
      if (lostReply)
        return yield* new ThreadLaunch.ThreadLaunchError({
          operation: "dispatch-message",
          commandId: input.commandId,
          projectId: input.projectId,
          threadId: thread.id,
          cause: new Error("Lost dispatch reply"),
        });
      return {
        threadId: thread.id,
        resumed: false,
        projection: {
          thread,
          runs: [],
          attempts: [],
          nodes: [],
          subagents: [],
          providerSessions: [],
          providerThreads: [],
          providerTurns: [],
          runtimeRequests: [],
          messages: [],
          plans: [],
          turnItems: [],
          checkpointScopes: [],
          checkpoints: [],
          contextHandoffs: [],
          contextTransfers: [],
          visibleTurnItems: [],
          updatedAt: now,
        },
      };
    });
  const layer = Layer.fresh(Hub.layer).pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), baseDir),
        Layer.mock(Providers.ProviderRegistry)({
          getProviders: Effect.sync(() => currentProviders),
        }),
        Layer.mock(ProviderInstances.ProviderInstanceRegistry)({
          getInstance: (id) =>
            Effect.sync(() => {
              const p = currentProviders.find((p) => p.instanceId === id);
              return p ? instance(p) : undefined;
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getByWorkspaceRoot: (workspaceRoot) =>
            Effect.gen(function* () {
              const now = DateTime.formatIso(yield* DateTime.now);
              return Option.some({
                id: ProjectId.make("project"),
                title: "Test",
                workspaceRoot,
                defaultModelSelection: null,
                scripts: [],
                createdAt: now,
                updatedAt: now,
                deletedAt: null,
              });
            }),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({ launch }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getShellSnapshot: () =>
            Effect.suspend(() =>
              probeFailure
                ? Effect.fail(
                    new Orchestrator.OrchestratorProjectionError({
                      threadId: ThreadId.make("probe"),
                    }),
                  )
                : Effect.succeed({
                    schemaVersion: 1,
                    snapshotSequence: 0,
                    threads: [...shells.values()].filter((s) => s.archivedAt === null),
                    archivedThreads: [...shells.values()].filter((s) => s.archivedAt !== null),
                  }),
            ),
        }),
        Layer.mock(Scheduler.Scheduler)({
          register: <E, R>(_name: string, work: Effect.Effect<void, E, R>) =>
            Effect.gen(function* () {
              const context = yield* Effect.context<R>();
              due = work.pipe(
                Effect.provideContext(context),
                Effect.mapError((cause) => new HubError({ message: "Scheduler failed", cause })),
              );
            }),
        }),
      ),
    ),
  );
  return {
    layer,
    calls,
    shells,
    tick: () => due,
    setProviders: (list: ReadonlyArray<ServerProvider>) => {
      currentProviders = list;
    },
    setProbeFailure: () => {
      probeFailure = true;
    },
    setLostReply: () => {
      lostReply = true;
    },
    redemptions: () => redemptions,
    settleAll: Effect.gen(function* () {
      const now = yield* DateTime.now;
      for (const [id, shell] of shells)
        shells.set(id, { ...shell, activeRunId: null, status: "completed", settledAt: now });
    }),
  };
};

const prepare = (hub: Hub.CodrHubService["Service"], workspace: string, name: string) =>
  Effect.gen(function* () {
    yield* hub.setNode({ nodeName: name, autopilotEnabled: true });
    yield* hub.upsertProject({ name: "One", autonomy: 25, localPath: workspace });
    yield* hub.upsertProject({ name: "Two", autonomy: 25, localPath: workspace });
  });
const snapshot = (hub: Hub.CodrHubService["Service"]) =>
  hub.subscribe().pipe(Stream.runHead, Effect.map(Option.getOrThrow));

it.layer(NodeServices.layer)("autopilot quota coordination", (it) => {
  it.effect("launches on one node and shows the owner on the waiting node", () =>
    Effect.gen(function* () {
      const { steve, edgar, now } = yield* fixture;
      const left = nodeHarness(steve.baseDir, [provider("left", now)]);
      const right = nodeHarness(edgar.baseDir, [provider("right", now)]);
      const results = yield* Effect.all(
        [
          Effect.gen(function* () {
            const hub = yield* Hub.CodrHubService;
            yield* prepare(hub, steve.baseDir, "Steve");
            return { run: yield* hub.runAutopilot(), state: yield* snapshot(hub) };
          }).pipe(Effect.provide(left.layer)),
          Effect.gen(function* () {
            const hub = yield* Hub.CodrHubService;
            yield* prepare(hub, edgar.baseDir, "Edgar");
            return { run: yield* hub.runAutopilot(), state: yield* snapshot(hub) };
          }).pipe(Effect.provide(right.layer)),
        ],
        { concurrency: "unbounded" },
      );
      expect(left.calls.length + right.calls.length).toBe(1);
      expect(results.flatMap((r) => r.run.launched)).toHaveLength(1);
      const waiting = results.find((r) => r.run.launched.length === 0);
      expect(waiting?.state.pace[0]?.state).toBe("unavailable");
      expect(waiting?.state.pace[0]?.reason).toContain("owned by");
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("hands over only after Autopilot is off and archived running work finishes", () =>
    Effect.gen(function* () {
      const { steve, edgar, now } = yield* fixture;
      const left = nodeHarness(steve.baseDir, [provider("left", now)]);
      const right = nodeHarness(edgar.baseDir, [provider("right", now)]);
      yield* Effect.gen(function* () {
        const owner = yield* Hub.CodrHubService;
        yield* prepare(owner, steve.baseDir, "Steve");
        expect((yield* owner.runAutopilot()).launched).toHaveLength(1);
        const archivedAt = yield* DateTime.now;
        for (const [id, shell] of left.shells) left.shells.set(id, { ...shell, archivedAt });
        yield* owner.setNode({ autopilotEnabled: false });
        yield* TestClock.adjust("1 minute");
        yield* left.tick();
        yield* Effect.gen(function* () {
          const waiter = yield* Hub.CodrHubService;
          yield* prepare(waiter, edgar.baseDir, "Edgar");
          yield* right.tick();
          expect(right.calls).toHaveLength(0);
          expect((yield* waiter.runAutopilot()).launched).toHaveLength(0);
          expect((yield* Effect.result(owner.sync({ remote: null })))._tag).toBe("Failure");
          yield* left.settleAll;
          yield* TestClock.adjust("1 minute");
          yield* left.tick();
          expect((yield* waiter.runAutopilot()).launched).toHaveLength(1);
        }).pipe(Effect.provide(right.layer));
      }).pipe(Effect.provide(left.layer));
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("pauses Run once for unknown account identity and remote disconnection", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { remote, steve, now } = yield* fixture;
      const known = provider("left", now);
      const left = nodeHarness(steve.baseDir, [{ ...known, auth: { status: "authenticated" } }]);
      yield* Effect.gen(function* () {
        const hub = yield* Hub.CodrHubService;
        yield* prepare(hub, steve.baseDir, "Steve");
        expect((yield* hub.runAutopilot()).launched).toHaveLength(0);
        expect((yield* snapshot(hub)).pace[0]?.reason).toContain("account email");
        left.setProviders([known]);
        yield* fs.rename(remote, `${remote}.offline`);
        expect((yield* hub.runAutopilot()).launched).toHaveLength(0);
        expect(left.calls).toHaveLength(0);
        expect((yield* snapshot(hub)).pace[0]?.state).toBe("unavailable");
      }).pipe(Effect.provide(left.layer));
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("shares concurrency across local instances of the same account", () =>
    Effect.gen(function* () {
      const { steve, now } = yield* fixture;
      const left = nodeHarness(steve.baseDir, [
        provider("first", now, 85.4),
        provider("second", now, 85.4),
      ]);
      yield* Effect.gen(function* () {
        const hub = yield* Hub.CodrHubService;
        yield* prepare(hub, steve.baseDir, "Steve");
        yield* hub.updateSettings({ maxConcurrentRuns: 4 });
        expect((yield* hub.runAutopilot()).launched).toHaveLength(1);
        left.setProviders([provider("first", now, 94), provider("second", now, 94)]);
        yield* TestClock.adjust("1 minute");
        yield* left.tick();
        expect(left.calls).toHaveLength(1);
        expect((yield* snapshot(hub)).pace.map((p) => p.running)).toEqual([1, 1]);
        expect(
          (yield* snapshot(hub)).pace.every((p) => p.reason.includes("Pacing owner: Steve")),
        ).toBe(true);
        left.setProviders([provider("replacement", now, 94)]);
        yield* TestClock.adjust("1 minute");
        yield* left.tick();
        expect(left.calls).toHaveLength(1);
        expect((yield* snapshot(hub)).pace[0]?.running).toBe(1);
      }).pipe(Effect.provide(left.layer));
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("lets only the owner redeem a capped account's banked reset once per pass", () =>
    Effect.gen(function* () {
      const { steve, edgar, now } = yield* fixture;
      const left = nodeHarness(steve.baseDir, [
        provider("first", now, 96),
        provider("second", now, 96),
      ]);
      const right = nodeHarness(edgar.baseDir, [provider("right", now, 96)]);
      yield* Effect.all(
        [
          Effect.gen(function* () {
            const hub = yield* Hub.CodrHubService;
            yield* prepare(hub, steve.baseDir, "Steve");
            yield* hub.updateSettings({ autoDeployBankedResets: true });
            yield* hub.runAutopilot();
          }).pipe(Effect.provide(left.layer)),
          Effect.gen(function* () {
            const hub = yield* Hub.CodrHubService;
            yield* prepare(hub, edgar.baseDir, "Edgar");
            yield* hub.updateSettings({ autoDeployBankedResets: true });
            yield* hub.runAutopilot();
          }).pipe(Effect.provide(right.layer)),
        ],
        { concurrency: "unbounded" },
      );
      expect(left.redemptions() + right.redemptions()).toBe(1);
      expect(left.calls.length + right.calls.length).toBe(0);
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect(
    "retains lost launch replies and does not release when thread state cannot be read",
    () =>
      Effect.gen(function* () {
        const { steve, edgar, now } = yield* fixture;
        const left = nodeHarness(steve.baseDir, [provider("left", now, 0)]);
        left.setLostReply();
        yield* Effect.gen(function* () {
          const hub = yield* Hub.CodrHubService;
          yield* prepare(hub, steve.baseDir, "Steve");
          expect((yield* hub.runAutopilot()).launched).toHaveLength(0);
          expect(left.calls).toHaveLength(1);
          const node = yield* Store.readNodeFile(steve.paths);
          expect(node.ledger).toHaveLength(1);
          expect(node.ledger[0]?.threadId).toBe(left.calls[0]?.threadId);
          yield* hub.setNode({ autopilotEnabled: false });
          left.setProbeFailure();
          yield* TestClock.adjust("1 minute");
          expect((yield* Effect.result(left.tick()))._tag).toBe("Failure");
          const key = Quota.accountKey(provider("right", now))!;
          const owner = yield* Quota.claim(edgar.paths, key, {
            version: 1,
            nodeId: yield* Quota.nodeIdentity(edgar.paths),
            nodeName: "Edgar",
          });
          expect(owner.nodeName).toBe("Steve");
        }).pipe(Effect.provide(left.layer));
      }).pipe(Effect.provide(ProcessRunner.layer)),
  );
  it.effect("retains running ledger entries beyond the recent history limit", () =>
    Effect.gen(function* () {
      const { steve, now } = yield* fixture;
      const left = nodeHarness(steve.baseDir, [provider("left", now)]);
      yield* Effect.gen(function* () {
        const hub = yield* Hub.CodrHubService;
        yield* prepare(hub, steve.baseDir, "Steve");
        yield* hub.runAutopilot();
      }).pipe(Effect.provide(left.layer));
      const node = yield* Store.readNodeFile(steve.paths);
      const active = node.ledger[0];
      if (!active) return yield* Effect.die("Expected an active launch");
      yield* Store.writeNodeFile(steve.paths, {
        ...node,
        ledger: [
          active,
          ...Array.from({ length: 200 }, (_, i) => ({
            ...active,
            threadId: ThreadId.make(`finished:${i}`),
            hubProjectId: "finished",
          })),
        ],
      });
      yield* Effect.gen(function* () {
        const hub = yield* Hub.CodrHubService;
        yield* hub.updateSettings({ maxConcurrentRuns: 4 });
        yield* hub.upsertProject({ id: "two", localPath: steve.baseDir });
        const result = yield* hub.runAutopilot();
        expect(result.launched, result.notes.join(" ")).toHaveLength(1);
        const saved = yield* Store.readNodeFile(steve.paths);
        expect(saved.ledger).toHaveLength(201);
        expect(saved.ledger[0]?.threadId).toBe(active.threadId);
      }).pipe(Effect.provide(Layer.fresh(left.layer)));
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("leaves a corrupt ledger and its existing ownership unchanged", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { steve, edgar, now } = yield* fixture;
      const key = Quota.accountKey(provider("left", now))!;
      yield* Quota.claim(steve.paths, key, {
        version: 1,
        nodeId: yield* Quota.nodeIdentity(steve.paths),
        nodeName: "Steve",
      });
      yield* fs.writeFileString(steve.paths.nodeFile, "{broken");
      const left = nodeHarness(steve.baseDir, [provider("left", now)]);
      yield* Effect.gen(function* () {
        const hub = yield* Hub.CodrHubService;
        expect((yield* Effect.result(hub.setNode({ autopilotEnabled: true })))._tag).toBe(
          "Failure",
        );
        expect((yield* Effect.result(hub.runAutopilot()))._tag).toBe("Failure");
        yield* TestClock.adjust("1 minute");
        expect((yield* Effect.result(left.tick()))._tag).toBe("Failure");
        expect(left.calls).toHaveLength(0);
        expect(yield* fs.readFileString(steve.paths.nodeFile)).toBe("{broken");
        expect(
          (yield* Quota.claim(edgar.paths, key, {
            version: 1,
            nodeId: yield* Quota.nodeIdentity(edgar.paths),
            nodeName: "Edgar",
          })).nodeName,
        ).toBe("Steve");
      }).pipe(Effect.provide(left.layer));
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );
});

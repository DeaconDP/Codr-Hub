/**
 * Codr-Hub service: the portfolio, the hub snapshot clients subscribe to, and
 * the autopilot that spends subscription quota on the top-ranked projects.
 * Design and constraints: docs/codr-hub/ARCHITECTURE.md.
 *
 * @module codrHub/CodrHubService
 */
import * as NodeOS from "node:os";

import {
  CommandId,
  HubError,
  HubFleetReport,
  MessageId,
  ProjectId,
  ThreadId,
  paceTargetFor,
  ProviderDriverKind,
  type HubAutonomy,
  type HubBoardCommand,
  type HubBoardSnapshot,
  type HubDeleteProjectInput,
  type HubGitGlance,
  type HubImportInput,
  type HubImportResult,
  type HubInsights,
  type HubProjectInsight,
  type HubLaunchRecord,
  type HubOk,
  type HubPace,
  type HubProject,
  type HubProjectView,
  type HubRecordTestVerdictInput,
  type HubRunAutopilotResult,
  type HubSetNodeInput,
  type HubSetStrategyInput,
  type HubSnapshot,
  type HubSyncInput,
  type HubSyncStatus,
  type HubT3SyncStatus,
  type HubTask,
  type HubUpdateSettingsInput,
  type HubUpsertProjectInput,
  type HubUpsertProjectsInput,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
  type TestHandoff,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ProcessRunner } from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { reduceBoard } from "./board.ts";
import {
  deezUuidToHubSlug,
  mergeDeezImport,
  mergeDeezTasks,
  readDeezProjects,
  readDeezTasks,
  slugifyProjectName,
} from "./deezImport.ts";
import { fleetShellBusy } from "./fleetDecide.ts";
import { GIT_GLANCE_ARGS, parseGitGlance } from "./gitGlance.ts";
import {
  activitySinceMs,
  bucketCommits,
  detectPlatform,
  isoFromMs,
  parseCommitTimestamps,
  yearStartMs,
} from "./insights.ts";
import { selectLaunchModel } from "./modelPolicy.ts";
import { computePace, type PaceDecision } from "./pacing.ts";
import * as Store from "./portfolioStore.ts";
import * as Quota from "./quotaOwnership.ts";
import {
  buildAutopilotPrompt,
  ineligibleReason,
  launchSettingsFor,
  pickNextProject,
  stageLabel,
} from "./selection.ts";
import { mergeT3Import, planT3Creates } from "./t3Import.ts";
import { ownerTryStage, reduceTestHandoff } from "./testHandoff.ts";

const AUTOPILOT_EVERY_MS = 60_000;
const GLANCE_EVERY_MS = 60_000;
const SYNC_EVERY_MS = 5 * 60_000;
const REFRESH_EVERY_MS = 20_000;
const LEDGER_LIMIT = 200;
const INSIGHTS_TTL_MS = 5 * 60_000;
/** Back-off before resubscribing to T3 project changes after the stream fails. */
const T3_WATCH_RETRY = "30 seconds";

export class CodrHubService extends Context.Service<
  CodrHubService,
  {
    readonly subscribe: () => Stream.Stream<HubSnapshot, HubError>;
    readonly subscribeBoard: (projectId: string) => Stream.Stream<HubBoardSnapshot, HubError>;
    readonly applyBoard: (command: HubBoardCommand) => Effect.Effect<HubBoardSnapshot, HubError>;
    readonly upsertProject: (input: HubUpsertProjectInput) => Effect.Effect<HubOk, HubError>;
    readonly upsertProjects: (input: HubUpsertProjectsInput) => Effect.Effect<HubOk, HubError>;
    readonly deleteProject: (input: HubDeleteProjectInput) => Effect.Effect<HubOk, HubError>;
    readonly recordTestVerdict: (
      input: HubRecordTestVerdictInput,
    ) => Effect.Effect<HubOk, HubError>;
    readonly setStrategy: (input: HubSetStrategyInput) => Effect.Effect<HubOk, HubError>;
    readonly updateSettings: (input: HubUpdateSettingsInput) => Effect.Effect<HubOk, HubError>;
    readonly setNode: (input: HubSetNodeInput) => Effect.Effect<HubOk, HubError>;
    readonly importProjects: (input: HubImportInput) => Effect.Effect<HubImportResult, HubError>;
    readonly sync: (input: HubSyncInput) => Effect.Effect<HubSyncStatus, HubError>;
    /** One autopilot pass now, launching at most one thread even when every provider is on pace. */
    readonly runAutopilot: () => Effect.Effect<HubRunAutopilotResult, HubError>;
    /** Platform and commit activity for this node's checkouts, cached for a few minutes. */
    readonly insights: () => Effect.Effect<HubInsights, HubError>;
  }
>()("t3/codrHub/CodrHubService") {}

const OK: HubOk = { ok: true };
const isHubError = Schema.is(HubError);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Where Deez-Project-Manager (Tauri id `com.deez.projectmanager`) keeps its data. */
const deezProjectManagerFile = (path: Path.Path, platform: NodeJS.Platform) => {
  const home = NodeOS.homedir();
  const id = "com.deez.projectmanager";
  switch (platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", id, "projects.json");
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
        id,
        "projects.json",
      );
    default:
      return path.join(
        process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"),
        id,
        "projects.json",
      );
  }
};

const isSettled = (shell: OrchestrationV2ThreadShell) =>
  shell.settledOverride === "settled" ||
  (shell.settledOverride !== "active" && shell.settledAt !== null);

const shellFinished = (shell: OrchestrationV2ThreadShell) =>
  shell.archivedAt === null &&
  shell.deletedAt === null &&
  shell.activeRunId === null &&
  (shell.pendingBackgroundTasks?.length ?? 0) === 0 &&
  shell.latestRunCompletedAt != null &&
  (shell.status === "idle" || shell.status === "completed");

const providerLabel = (provider: ServerProvider) => provider.displayName ?? provider.driver;
const quotaGroup = (provider: ServerProvider) =>
  Quota.accountKey(provider) ?? `instance:${provider.instanceId}`;

const isUsable = (provider: ServerProvider) =>
  provider.enabled &&
  provider.status !== "error" &&
  provider.status !== "disabled" &&
  provider.auth.status !== "unauthenticated";

export const layer = Layer.effect(
  CodrHubService,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const runner = yield* ProcessRunner;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const projectsService = yield* ProjectService.ProjectService;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const scheduler = yield* Scheduler.Scheduler;
    const platform = yield* HostProcess.Platform;

    // Everything below needs these services; provide them once.
    const io = <A, E>(
      effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ProcessRunner>,
    ) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ProcessRunner, runner),
      );

    const paths = Store.portfolioPaths(path, config.stateDir);
    yield* io(Store.ensurePortfolioRepo(paths)).pipe(
      Effect.catch((cause) => Effect.logWarning("Codr-Hub portfolio repo unavailable", { cause })),
    );

    const loadFromDisk = io(
      Effect.all({
        hub: Store.readHubFile(paths),
        projects: Store.readProjects(paths),
        handoffs: Store.readHandoffs(paths),
        tasks: Store.readTasks(paths),
      }),
    );
    const initial = yield* loadFromDisk.pipe(
      Effect.catch((cause) =>
        Effect.logError("Codr-Hub could not read the portfolio; starting empty", { cause }).pipe(
          Effect.as({
            hub: undefined,
            projects: [] as HubProject[],
            handoffs: [] as TestHandoff[],
            tasks: [] as HubTask[],
          }),
        ),
      ),
    );
    const hubRef = yield* Ref.make(initial.hub ?? Store.EMPTY_HUB_FILE);
    const projectsRef = yield* Ref.make<ReadonlyMap<string, HubProject>>(
      new Map(initial.projects.map((project) => [project.id, project])),
    );
    const handoffsRef = yield* Ref.make<ReadonlyMap<string, TestHandoff>>(
      new Map(initial.handoffs.map((handoff) => [handoff.projectId, handoff])),
    );
    const tasksRef = yield* Ref.make<ReadonlyMap<string, HubTask>>(
      new Map(initial.tasks.map((task) => [task.id, task])),
    );
    const boardRevisionRef = yield* Ref.make(0);
    const initialNode = yield* io(Store.readNodeFile(paths)).pipe(Effect.result);
    const nodeReadError =
      initialNode._tag === "Failure"
        ? new HubError({
            message:
              "Autopilot is paused. Repair codr-hub/node.json and restart before pacing or handing over ownership.",
            cause: initialNode.failure,
          })
        : null;
    if (nodeReadError !== null)
      yield* Effect.logError("Codr-Hub node file unreadable; autopilot paused", {
        cause: nodeReadError,
      });
    const nodeRef = yield* Ref.make<Store.NodeFile>(
      initialNode._tag === "Success"
        ? initialNode.success
        : { nodeName: Store.defaultNodeName(), autopilotEnabled: false, ledger: [] },
    );
    const glancesRef = yield* Ref.make<ReadonlyMap<string, HubGitGlance | null>>(new Map());
    const existsRef = yield* Ref.make<ReadonlyMap<string, boolean>>(new Map());
    const syncRef = yield* Ref.make<{ lastSyncAt: string | null; lastError: string | null }>({
      lastSyncAt: null,
      lastError: null,
    });
    const t3SyncRef = yield* Ref.make<Omit<HubT3SyncStatus, "enabled">>({
      lastSyncAt: null,
      lastResult: null,
      lastError: null,
    });
    const noteRef = yield* Ref.make<string | null>(null);
    const timersRef = yield* Ref.make({ autopilot: 0, glance: 0, sync: 0, refresh: 0 });
    const writeLock = yield* Semaphore.make(1);
    const autopilotLock = yield* Semaphore.make(1);
    const quotaNodeId = yield* io(
      Quota.nodeIdentity(paths).pipe(Effect.provideService(Crypto.Crypto, crypto)),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Codr-Hub quota identity unavailable", { cause }).pipe(Effect.as(null)),
      ),
    );
    const quotaRef = yield* Ref.make<ReadonlyMap<string, { allowed: boolean; reason: string }>>(
      new Map(),
    );
    const releaseQuotaPending = yield* Ref.make(true);
    const changes = yield* PubSub.sliding<void>(1);
    const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
    const boardChanges = yield* PubSub.sliding<string>(16);
    const notifyBoard = (projectId: string) =>
      PubSub.publish(boardChanges, projectId).pipe(Effect.asVoid);

    const nowMs = Clock.currentTimeMillis;
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const uuid = crypto
      .randomUUIDv4()
      .pipe(
        Effect.mapError((cause) => new HubError({ message: "Could not generate an id.", cause })),
      );

    const localPathOf = (project: HubProject, nodeName: string) =>
      project.hosts[nodeName]?.path ?? null;

    const glance = (cwd: string) =>
      runner.run({ command: "git", args: GIT_GLANCE_ARGS, cwd, timeout: "10 seconds" }).pipe(
        Effect.map((out): HubGitGlance | null =>
          out.code === 0 ? parseGitGlance(out.stdout) : null,
        ),
        Effect.orElseSucceed(() => null),
      );

    const refreshGlances = Effect.gen(function* () {
      const node = yield* Ref.get(nodeRef);
      const localPaths = [...(yield* Ref.get(projectsRef)).values()].flatMap((project) => {
        const local = localPathOf(project, node.nodeName);
        return local ? [local] : [];
      });
      const results = yield* Effect.forEach(
        localPaths,
        (local) =>
          Effect.gen(function* () {
            const exists = yield* fs.exists(local).pipe(Effect.orElseSucceed(() => false));
            return [local, exists, exists ? yield* glance(local) : null] as const;
          }),
        { concurrency: 4 },
      );
      yield* Ref.set(existsRef, new Map(results.map(([local, exists]) => [local, exists])));
      yield* Ref.set(glancesRef, new Map(results.map(([local, , git]) => [local, git])));
    });

    // --- dashboard insights ----------------------------------------------------

    const gitOut = (cwd: string, args: ReadonlyArray<string>) =>
      runner.run({ command: "git", args, cwd, timeout: "15 seconds" }).pipe(
        Effect.map((out) => (out.code === 0 ? out.stdout.trim() : "")),
        Effect.orElseSucceed(() => ""),
      );

    const projectInsight = Effect.fn("codrHub.projectInsight")(function* (
      project: HubProject,
      cwd: string,
      now: number,
    ) {
      const entries = yield* fs.readDirectory(cwd).pipe(Effect.orElseSucceed(() => []));
      // Non-git and empty repos answer non-zero, which reads as no commits.
      const total = Number(yield* gitOut(cwd, ["rev-list", "--count", "HEAD"])) || 0;
      const since = isoFromMs(activitySinceMs(now));
      const recent = parseCommitTimestamps(
        yield* gitOut(cwd, ["log", "--format=%ct", `--since=${since}`, "HEAD"]),
      );
      const [last] = parseCommitTimestamps(yield* gitOut(cwd, ["log", "-1", "--format=%ct"]));
      return {
        projectId: project.id,
        platform: detectPlatform(project.tags, entries),
        commits: bucketCommits(recent, total, now, yearStartMs(now)),
        lastCommitAt: last === undefined ? null : isoFromMs(last * 1000),
      } satisfies HubProjectInsight;
    });

    const computeInsights = Effect.gen(function* () {
      const now = yield* nowMs;
      const node = yield* Ref.get(nodeRef);
      const checkouts = [...(yield* Ref.get(projectsRef)).values()].flatMap((project) => {
        const local = project.archived ? null : localPathOf(project, node.nodeName);
        return local ? [{ project, local }] : [];
      });
      const projects = yield* Effect.forEach(
        checkouts,
        ({ project, local }) =>
          Effect.gen(function* () {
            const exists = yield* fs.exists(local).pipe(Effect.orElseSucceed(() => false));
            return exists ? [yield* projectInsight(project, local, now)] : [];
          }),
        { concurrency: 4 },
      );
      return {
        nodeName: node.nodeName,
        computedAt: isoFromMs(now),
        projects: projects.flat(),
      } satisfies HubInsights;
    });

    const insightsRef = yield* Ref.make<{ atMs: number; value: HubInsights } | null>(null);
    const insights = Effect.fn("codrHub.insights")(function* () {
      const now = yield* nowMs;
      const node = yield* Ref.get(nodeRef);
      const cached = yield* Ref.get(insightsRef);
      if (
        cached !== null &&
        cached.value.nodeName === node.nodeName &&
        now - cached.atMs < INSIGHTS_TTL_MS
      )
        return cached.value;
      const value = yield* computeInsights;
      yield* Ref.set(insightsRef, { atMs: now, value });
      return value;
    });

    // --- snapshot ------------------------------------------------------------

    const ledgerState = Effect.gen(function* () {
      if (nodeReadError !== null) return yield* nodeReadError;
      const node = yield* Ref.get(nodeRef);
      const shells = yield* threadManagement.getShellSnapshot().pipe(
        Effect.map(
          (snapshot) =>
            new Map<string, OrchestrationV2ThreadShell>(
              [...snapshot.threads, ...snapshot.archivedThreads].map((shell) => [shell.id, shell]),
            ),
        ),
        Effect.mapError(
          (cause) =>
            new HubError({
              message: "Could not verify autopilot thread state; pacing is paused.",
              cause,
            }),
        ),
      );
      const records = node.ledger.map((record) => {
        const shell = shells.get(record.threadId);
        const finished = shell !== undefined && shellFinished(shell);
        return {
          record,
          running:
            shell !== undefined &&
            (shell.activeRunId !== null || (shell.pendingBackgroundTasks?.length ?? 0) > 0),
          // Archived or deleted threads drop out of the active snapshot.
          awaiting: shell !== undefined && shell.archivedAt === null && !isSettled(shell),
          finished,
          outstanding:
            shell !== undefined &&
            shell.archivedAt === null &&
            shell.deletedAt === null &&
            !finished,
        };
      });
      return { node, records };
    });

    const buildViews = Effect.gen(function* () {
      const { node, records } = yield* ledgerState;
      const glances = yield* Ref.get(glancesRef);
      const exists = yield* Ref.get(existsRef);
      const handoffs = yield* Ref.get(handoffsRef);
      const views = [...(yield* Ref.get(projectsRef)).values()].map((project): HubProjectView => {
        const local = localPathOf(project, node.nodeName);
        const mine = records.filter((entry) => entry.record.hubProjectId === project.id);
        return {
          project,
          localPath: local,
          pathExists: local !== null && (exists.get(local) ?? false),
          git: local === null ? null : (glances.get(local) ?? null),
          awaitingReview: mine.filter((entry) => entry.awaiting).length,
          running: mine.filter((entry) => entry.running).length,
          lastLaunchAt: mine.at(-1)?.record.launchedAt ?? null,
          handoff: handoffs.get(project.id) ?? null,
        };
      });
      return { node, records, views };
    });

    const paceDecisions = Effect.gen(function* () {
      const hub = yield* Ref.get(hubRef);
      const { records } = yield* ledgerState;
      const now = yield* nowMs;
      const list = yield* providers.getProviders;
      const groups = new Map(list.map((provider) => [provider.instanceId, quotaGroup(provider)]));
      const runningByGroup = new Map<string, number>();
      let unknownRunning = 0;
      for (const entry of records) {
        if (!entry.running) continue;
        const group = entry.record.quotaAccountKey ?? groups.get(entry.record.instanceId);
        // Older ledgers have no account key. If their instance is gone, count
        // them against every account until their work finishes.
        if (group === undefined) unknownRunning += 1;
        else runningByGroup.set(group, (runningByGroup.get(group) ?? 0) + 1);
      }
      return list
        .filter((provider) => provider.enabled)
        .map((provider) => ({
          provider,
          decision: computePace(
            {
              instanceId: provider.instanceId,
              driver: provider.driver,
              label: providerLabel(provider),
              usable: isUsable(provider),
              windows: provider.usageLimits?.unavailable
                ? []
                : list
                    .filter(
                      (other) =>
                        other.enabled &&
                        groups.get(other.instanceId) === groups.get(provider.instanceId),
                    )
                    .flatMap((other) =>
                      other.usageLimits?.unavailable ? [] : (other.usageLimits?.windows ?? []),
                    )
                    .toSorted((a, b) => b.usedPercent - a.usedPercent),
              bankedResets: provider.usageLimits?.resetCredits?.availableCount ?? 0,
              bankedResetExpiresAt: provider.usageLimits?.resetCredits?.nextExpiresAt ?? null,
              running: (runningByGroup.get(groups.get(provider.instanceId)!) ?? 0) + unknownRunning,
            },
            {
              targetPercent: paceTargetFor(hub.settings, provider.driver),
              maxConcurrentRuns: hub.settings.maxConcurrentRuns,
              autoDeployBankedResets: hub.settings.autoDeployBankedResets,
              nowMs: now,
            },
          ),
        }));
    });

    const fleetReportFile = path.join(config.stateDir, "codr-hub", "fleet.json");
    const fleetActivityFile = path.join(config.stateDir, "codr-hub", "fleet-activity.json");
    const decodeFleetReport = Schema.decodeUnknownEffect(Schema.fromJsonString(HubFleetReport));

    const readFleetReport = fs.readFileString(fleetReportFile).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.flatMap((text) => (text.trim() === "" ? Effect.undefined : decodeFleetReport(text))),
      Effect.orElseSucceed(() => undefined),
    );

    const encodeFleetActivity = Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          atMs: Schema.Number,
          pid: Schema.Number,
          busy: Schema.Boolean,
        }),
      ),
    );

    const publishFleetActivity = Effect.gen(function* () {
      const shells = yield* threadManagement
        .getShellSnapshot()
        .pipe(Effect.orElseSucceed(() => null));
      if (shells === null) return;
      const busy = fleetShellBusy([...shells.threads, ...shells.archivedThreads]);
      const atMs = yield* nowMs;
      const contents = yield* encodeFleetActivity({ atMs, pid: process.pid, busy });
      yield* writeFileStringAtomically({
        filePath: fleetActivityFile,
        contents: `${contents}\n`,
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Codr-Hub fleet activity was not written", { cause }),
        ),
      );
    });

    const buildSnapshot = Effect.gen(function* () {
      const hub = yield* Ref.get(hubRef);
      const { node, views } = yield* buildViews;
      const quota = yield* Ref.get(quotaRef);
      const pace: HubPace[] = (yield* paceDecisions).map(({ provider, decision }) => {
        const status = quota.get(quotaGroup(provider));
        return status === undefined
          ? decision.pace
          : {
              ...decision.pace,
              state: status.allowed ? decision.pace.state : "unavailable",
              desiredConcurrency: status.allowed ? decision.pace.desiredConcurrency : 0,
              reason: status.allowed ? `${decision.pace.reason} ${status.reason}` : status.reason,
            };
      });
      const sync = yield* Ref.get(syncRef);
      const deezPath = deezProjectManagerFile(path, platform);
      return {
        nodeName: node.nodeName,
        autopilotEnabled: node.autopilotEnabled,
        autopilotNote: yield* Ref.get(noteRef),
        settings: hub.settings,
        strategy: hub.strategy,
        projects: views,
        pace,
        recentLaunches: node.ledger.slice(-20).toReversed(),
        sync: {
          portfolioPath: paths.portfolioDir,
          remote: yield* io(Store.readRemote(paths)),
          lastSyncAt: sync.lastSyncAt,
          lastError: sync.lastError,
        },
        deezProjectManagerPath: (yield* fs.exists(deezPath).pipe(Effect.orElseSucceed(() => false)))
          ? deezPath
          : null,
        fleet: yield* readFleetReport,
        t3Sync: { enabled: node.syncT3 === true, ...(yield* Ref.get(t3SyncRef)) },
      } satisfies HubSnapshot;
    });

    const subscribe: CodrHubService["Service"]["subscribe"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(buildSnapshot),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => buildSnapshot)),
          );
        }),
      );

    const buildBoard = Effect.fn("codrHub.buildBoard")(function* (projectId: string) {
      const project = (yield* Ref.get(projectsRef)).get(projectId);
      if (!project) {
        return yield* new HubError({ message: `Project ${projectId} not found.` });
      }
      const tasks = [...(yield* Ref.get(tasksRef)).values()].filter(
        (task) => task.projectId === projectId,
      );
      return {
        projectId,
        project: { id: project.id, name: project.name, status: project.status },
        revision: yield* Ref.get(boardRevisionRef),
        tasks,
      } satisfies HubBoardSnapshot;
    });

    const subscribeBoard: CodrHubService["Service"]["subscribeBoard"] = (projectId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(boardChanges);
          return Stream.concat(
            Stream.fromEffect(buildBoard(projectId)),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((changed) => changed === projectId),
              Stream.mapEffect(() => buildBoard(projectId)),
            ),
          );
        }),
      );

    /** Callers hold writeLock while reading the current snapshot and saving it. */
    const write = Effect.fn("codrHub.write")(
      function* <A>(message: string, effect: Effect.Effect<A, HubError>) {
        yield* io(Store.ensurePortfolioIdle(paths));
        const result = yield* effect;
        yield* io(Store.commitPortfolio(paths, message)).pipe(
          Effect.catch((cause) => Effect.logWarning("Codr-Hub commit failed", { cause })),
        );
        return result;
      },
      Effect.tap(() => notify),
    );

    const saveProject = (project: HubProject) =>
      io(Store.writeProject(paths, project)).pipe(
        Effect.andThen(
          Ref.update(projectsRef, (current) => new Map(current).set(project.id, project)),
        ),
      );

    const saveHandoff = (handoff: TestHandoff) =>
      io(Store.writeHandoff(paths, handoff)).pipe(
        Effect.andThen(
          Ref.update(handoffsRef, (current) => new Map(current).set(handoff.projectId, handoff)),
        ),
      );

    const saveTask = (task: HubTask) =>
      io(Store.writeTask(paths, task)).pipe(
        Effect.andThen(Ref.update(tasksRef, (current) => new Map(current).set(task.id, task))),
      );

    const dropTask = (taskId: string) =>
      io(Store.removeTask(paths, taskId)).pipe(
        Effect.andThen(
          Ref.update(tasksRef, (current) => {
            const next = new Map(current);
            next.delete(taskId);
            return next;
          }),
        ),
      );

    const applyBoard: CodrHubService["Service"]["applyBoard"] = Effect.fn("codrHub.applyBoard")(
      function* (command: Parameters<CodrHubService["Service"]["applyBoard"]>[0]) {
        const project = (yield* Ref.get(projectsRef)).get(command.projectId);
        if (!project) {
          return yield* new HubError({ message: `Project ${command.projectId} not found.` });
        }
        const now = yield* nowIso;
        const current = yield* Ref.get(tasksRef);
        const reduced = reduceBoard(current, command, now);
        if (!reduced.ok) {
          const error = reduced.error;
          const message =
            error._tag === "TaskNotFound"
              ? `Task ${error.taskId} not found.`
              : error._tag === "CrossProject"
                ? `Task ${error.taskId} belongs to another project.`
                : error._tag === "DuplicateTask"
                  ? `Task ${error.taskId} already exists.`
                  : error.reason;
          return yield* new HubError({ message });
        }
        if (reduced.touched.length > 0) {
          yield* write(
            `Board ${command.type} on ${project.name}`,
            Effect.forEach(
              reduced.touched,
              (touch) => (touch.op === "write" ? saveTask(touch.task) : dropTask(touch.taskId)),
              { discard: true },
            ).pipe(
              Effect.andThen(Ref.update(boardRevisionRef, (revision) => revision + 1)),
              Effect.andThen(Ref.set(tasksRef, reduced.tasks)),
            ),
          );
          yield* notifyBoard(command.projectId);
        }
        return yield* buildBoard(command.projectId);
      },
      writeLock.withPermits(1),
    );

    const saveNode = Effect.fn("codrHub.saveNode")(function* (
      update: (node: Store.NodeFile) => Store.NodeFile,
    ) {
      if (nodeReadError !== null) return yield* nodeReadError;
      const next = update(yield* Ref.get(nodeRef));
      yield* io(Store.writeNodeFile(paths, next));
      yield* Ref.set(nodeRef, next);
    });

    const uniqueId = (name: string, taken: ReadonlyMap<string, unknown>) => {
      const base = slugifyProjectName(name);
      let id = base;
      for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
      return id;
    };

    /** Applies one upsert to `projects` (in place) and returns the saved record. */
    const applyUpsert = (
      projects: Map<string, HubProject>,
      input: HubUpsertProjectInput,
      nodeName: string,
      now: string,
    ): HubProject | HubError => {
      const existing = input.id === undefined ? undefined : projects.get(input.id);
      if (input.id !== undefined && existing === undefined) {
        return new HubError({ message: `Project ${input.id} not found.` });
      }
      if (existing === undefined && input.name === undefined) {
        return new HubError({ message: "A new project needs a name." });
      }
      const base: HubProject = existing ?? {
        id: uniqueId(input.name!, projects),
        name: input.name!,
        priority: "none",
        status: "active",
        stage: "plan",
        strategyId: null,
        category: null,
        tags: [],
        repoUrl: null,
        notes: "",
        hosts: {},
        autonomy: 0,
        reviewBudget: 2,
        sortIndex: projects.size,
        favorite: false,
        archived: false,
        lane: null,
        jobKind: "dev",
        createdAt: now,
        updatedAt: now,
      };
      const { id: _id, localPath, ...patch } = input;
      const hosts = { ...base.hosts };
      if (localPath === null) delete hosts[nodeName];
      else if (localPath !== undefined) hosts[nodeName] = { path: localPath };
      const next: HubProject = {
        ...base,
        ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
        hosts,
        updatedAt: now,
      };
      projects.set(next.id, next);
      return next;
    };

    const upsertProject: CodrHubService["Service"]["upsertProject"] = (input) =>
      upsertProjects({ projects: [input] });

    const upsertProjects: CodrHubService["Service"]["upsertProjects"] = Effect.fn(
      "codrHub.upsertProjects",
    )(function* (input: Parameters<CodrHubService["Service"]["upsertProjects"]>[0]) {
      if (input.projects.length === 0) return OK;
      const projects = new Map(yield* Ref.get(projectsRef));
      const node = yield* Ref.get(nodeRef);
      const now = yield* nowIso;
      const saved: HubProject[] = [];
      for (const entry of input.projects) {
        const next = applyUpsert(projects, entry, node.nodeName, now);
        if (isHubError(next)) return yield* next;
        saved.push(next);
      }
      const [first] = saved;
      const message =
        saved.length === 1 && first
          ? `${input.projects[0]?.id === undefined ? "Add" : "Update"} ${first.name}`
          : `Update ${saved.length} projects`;
      yield* write(message, Effect.forEach(saved, saveProject, { discard: true }));
      if (input.projects.some((entry) => entry.localPath !== undefined)) {
        yield* refreshGlances.pipe(Effect.andThen(notify));
      }
      return OK;
    }, writeLock.withPermits(1));

    const deleteProject: CodrHubService["Service"]["deleteProject"] = Effect.fn(
      "codrHub.deleteProject",
    )(function* (input: Parameters<CodrHubService["Service"]["deleteProject"]>[0]) {
      const project = (yield* Ref.get(projectsRef)).get(input.id);
      if (!project) return OK;
      yield* write(
        `Remove ${project.name}`,
        Effect.gen(function* () {
          yield* io(Store.removeProject(paths, input.id));
          yield* io(Store.removeHandoff(paths, input.id));
          yield* io(Store.removeTasksForProject(paths, input.id));
          yield* Ref.update(projectsRef, (current) => {
            const next = new Map(current);
            next.delete(input.id);
            return next;
          });
          yield* Ref.update(handoffsRef, (current) => {
            const next = new Map(current);
            next.delete(input.id);
            return next;
          });
          yield* Ref.update(tasksRef, (current) => {
            const next = new Map(current);
            for (const [taskId, task] of next) {
              if (task.projectId === input.id) next.delete(taskId);
            }
            return next;
          });
          yield* Ref.update(boardRevisionRef, (revision) => revision + 1);
        }),
      );
      yield* notifyBoard(input.id);
      return OK;
    }, writeLock.withPermits(1));

    const recordTestVerdict: CodrHubService["Service"]["recordTestVerdict"] = Effect.fn(
      "codrHub.recordTestVerdict",
    )(function* (input: Parameters<CodrHubService["Service"]["recordTestVerdict"]>[0]) {
      const project = (yield* Ref.get(projectsRef)).get(input.projectId);
      if (!project)
        return yield* new HubError({ message: `Project ${input.projectId} not found.` });
      const current = (yield* Ref.get(handoffsRef)).get(input.projectId) ?? null;
      const now = yield* nowIso;
      const next =
        input.verdict === "ship"
          ? reduceTestHandoff(current, { type: "ship", updatedAt: now })
          : reduceTestHandoff(current, {
              type: "fix",
              note: input.note,
              notedAt: now,
              updatedAt: now,
            });
      if (next === null || next === current) {
        return yield* new HubError({
          message: `${project.name} is not waiting for that verdict.`,
        });
      }
      yield* write(`Test verdict for ${project.name}`, saveHandoff(next));
      return OK;
    }, writeLock.withPermits(1));

    const setStrategy: CodrHubService["Service"]["setStrategy"] = Effect.fn("codrHub.setStrategy")(
      function* (input: Parameters<CodrHubService["Service"]["setStrategy"]>[0]) {
        const ids = input.strategy.map((priority) => priority.id);
        if (new Set(ids).size !== ids.length) {
          return yield* new HubError({ message: "Strategy priorities need unique ids." });
        }
        const next = { ...(yield* Ref.get(hubRef)), strategy: input.strategy };
        yield* write(
          "Update strategy",
          io(Store.writeHubFile(paths, next)).pipe(Effect.andThen(Ref.set(hubRef, next))),
        );
        return OK;
      },
      writeLock.withPermits(1),
    );

    const updateSettings: CodrHubService["Service"]["updateSettings"] = Effect.fn(
      "codrHub.updateSettings",
    )(function* (input: Parameters<CodrHubService["Service"]["updateSettings"]>[0]) {
      const hub = yield* Ref.get(hubRef);
      const { paceTargets, nodeColors, ...rest } = input;
      const patch = Object.fromEntries(
        Object.entries(rest).filter(([, value]) => value !== undefined),
      );
      const nextTargets = {
        claudeAgent: paceTargets?.claudeAgent ?? hub.settings.paceTargets.claudeAgent,
        cursor: paceTargets?.cursor ?? hub.settings.paceTargets.cursor,
        codex: paceTargets?.codex ?? hub.settings.paceTargets.codex,
      };
      const nextColors = { ...hub.settings.nodeColors };
      for (const [nodeName, color] of Object.entries(nodeColors ?? {})) {
        if (color === null) delete nextColors[nodeName];
        else nextColors[nodeName] = color;
      }
      const next = {
        ...hub,
        settings: {
          ...hub.settings,
          ...patch,
          paceTargets: nextTargets,
          nodeColors: nextColors,
        },
      };
      yield* write(
        "Update hub settings",
        io(Store.writeHubFile(paths, next)).pipe(Effect.andThen(Ref.set(hubRef, next))),
      );
      return OK;
    }, writeLock.withPermits(1));

    const setNode: CodrHubService["Service"]["setNode"] = Effect.fn("codrHub.setNode")(
      function* (input: Parameters<CodrHubService["Service"]["setNode"]>[0]) {
        if (nodeReadError !== null) return yield* nodeReadError;
        const before = yield* Ref.get(nodeRef);
        const rename =
          input.nodeName !== undefined && input.nodeName !== before.nodeName
            ? input.nodeName
            : null;
        if (rename !== null) {
          // Checkouts are keyed by node name; carry this node's paths over.
          const now = yield* nowIso;
          const moved = [...(yield* Ref.get(projectsRef)).values()].flatMap((project) => {
            const host = project.hosts[before.nodeName];
            if (!host || project.hosts[rename]) return [];
            const { [before.nodeName]: _old, ...rest } = project.hosts;
            return [{ ...project, hosts: { ...rest, [rename]: host }, updatedAt: now }];
          });
          yield* write(
            `Rename node ${before.nodeName} to ${rename}`,
            Effect.forEach(moved, saveProject, { discard: true }),
          );
        }
        yield* saveNode((node) => ({
          ...node,
          nodeName: rename ?? node.nodeName,
          autopilotEnabled: input.autopilotEnabled ?? node.autopilotEnabled,
          syncT3: input.syncT3 ?? node.syncT3,
        }));
        if (input.autopilotEnabled !== undefined) {
          yield* Ref.update(timersRef, (timers) => ({ ...timers, autopilot: 0 }));
          yield* Ref.set(releaseQuotaPending, true);
        }
        if (input.syncT3 !== undefined) yield* watchT3(input.syncT3);
        yield* notify;
        return OK;
      },
      writeLock.withPermits(1),
      autopilotLock.withPermits(1),
    );

    // --- Sync with T3 ----------------------------------------------------------

    /** Adds one Hub checkout to T3 through the normal project-create command. */
    const createT3Project = Effect.fn("codrHub.createT3Project")(function* (
      project: HubProject,
      workspaceRoot: string,
    ) {
      // Also true for a root T3 knows under another spelling, or one the owner removed in T3.
      const known = yield* projectsService.getByWorkspaceRoot(workspaceRoot, {
        includeDeleted: true,
      });
      if (Option.isSome(known)) return false;
      yield* projectsService.create({
        commandId: CommandId.make(`codr-hub:t3-sync:${yield* uuid}`),
        projectId: ProjectId.make(yield* uuid),
        title: project.name,
        workspaceRoot,
      });
      return true;
    });

    /**
     * Brings this node's T3 projects into the portfolio and, with `toT3`, adds
     * this node's Hub checkouts to T3. Never deletes on either side. Callers
     * hold writeLock.
     */
    const syncWithT3 = Effect.fn("codrHub.syncWithT3")(
      function* (options: { readonly toT3: boolean }) {
        const node = yield* Ref.get(nodeRef);
        const existing = [...(yield* Ref.get(projectsRef)).values()];
        const shells = yield* projectsService
          .listShells()
          .pipe(
            Effect.mapError(
              (cause) =>
                new HubError({ message: "Could not read this node's T3 projects.", cause }),
            ),
          );
        const missingPathIds = new Set<string>();
        for (const project of existing) {
          const host = project.hosts[node.nodeName];
          if (host && !(yield* fs.exists(host.path).pipe(Effect.orElseSucceed(() => false)))) {
            missingPathIds.add(project.id);
          }
        }
        const now = yield* nowIso;
        const merged = mergeT3Import(existing, shells, {
          nodeName: node.nodeName,
          nowIso: now,
          missingPathIds,
        });
        if (merged.upserts.length > 0) {
          yield* write(
            `Import ${merged.imported} new, ${merged.updated} linked projects from T3 on ${node.nodeName}`,
            Effect.forEach(merged.upserts, saveProject, { discard: true }),
          );
          yield* refreshGlances;
        }
        let created = 0;
        const failures: string[] = [];
        if (options.toT3) {
          const plan = planT3Creates([...(yield* Ref.get(projectsRef)).values()], shells, {
            nodeName: node.nodeName,
            missingPathIds,
          });
          for (const { project, workspaceRoot } of plan) {
            const result = yield* Effect.result(createT3Project(project, workspaceRoot));
            if (result._tag === "Failure")
              failures.push(`${project.name}: ${result.failure.message}`);
            else if (result.success) created += 1;
          }
        }
        const result = {
          imported: merged.imported,
          updated: merged.updated,
          skipped: merged.skipped,
          created,
        };
        yield* Ref.set(t3SyncRef, {
          lastSyncAt: now,
          lastResult: result,
          lastError: failures.length === 0 ? null : `Not added to T3: ${failures.join("; ")}`,
        });
        yield* notify;
        return result;
      },
      Effect.tapError((error) =>
        nowIso.pipe(
          Effect.flatMap((now) =>
            Ref.update(t3SyncRef, (state) => ({
              ...state,
              lastSyncAt: now,
              lastError: error.message,
            })),
          ),
          Effect.andThen(notify),
        ),
      ),
    );

    // Every wake runs one sync; wakes that arrive during a sync collapse into
    // one more, so a burst of T3 project events costs at most two passes.
    const t3Wake = yield* Queue.sliding<void>(1);
    yield* Stream.fromQueue(t3Wake).pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          if ((yield* Ref.get(nodeRef)).syncT3 !== true) return;
          yield* syncWithT3({ toT3: true }).pipe(
            writeLock.withPermits(1),
            Effect.catch((cause) => Effect.logWarning("Codr-Hub T3 sync failed", { cause })),
          );
        }),
      ),
      Effect.forkScoped,
    );

    // Wakes once per (re)subscribe, which covers startup, turning sync on, and
    // events missed while resubscribing, then on each committed project event.
    // Thread events are dropped at the projection so the live buffer stays tiny.
    const watchT3Projects = Stream.unwrap(
      Effect.map(applicationEvents.latestApplicationSequence, (afterSequence) =>
        Stream.concat(
          Stream.make(true),
          applicationEvents
            .streamProjectedApplicationEvents({
              afterSequence,
              project: (event) => ({ sequence: event.sequence, project: "aggregateKind" in event }),
            })
            .pipe(Stream.filter((event) => event.project)),
        ),
      ),
    ).pipe(
      Stream.tapError((cause) => Effect.logWarning("Codr-Hub T3 project watch failed", { cause })),
      Stream.retry(Schedule.spaced(T3_WATCH_RETRY)),
      Stream.runForEach(() => Queue.offer(t3Wake, undefined)),
    );

    // Subscribed only while sync is on, so an idle node pays nothing per event.
    const layerScope = yield* Effect.scope;
    const t3WatchRef = yield* Ref.make<Fiber.Fiber<unknown, unknown> | null>(null);
    const watchT3 = Effect.fn("codrHub.watchT3")(function* (on: boolean) {
      const current = yield* Ref.get(t3WatchRef);
      if (on && current === null) {
        yield* Ref.set(t3WatchRef, yield* Effect.forkIn(watchT3Projects, layerScope));
      } else if (!on && current !== null) {
        yield* Ref.set(t3WatchRef, null);
        yield* Fiber.interrupt(current);
      }
    });

    const importDeezProjects = Effect.fn("codrHub.importDeezProjects")(function* (
      input: Extract<HubImportInput, { source: "deez-project-manager" }>,
    ) {
      const file = input.path ?? deezProjectManagerFile(path, platform);
      const text = yield* fs
        .readFileString(file)
        .pipe(
          Effect.mapError((cause) => new HubError({ message: `Could not read ${file}.`, cause })),
        );
      const json = yield* decodeJson(text).pipe(
        Effect.mapError((cause) => new HubError({ message: `${file} is not valid JSON.`, cause })),
      );
      const node = yield* Ref.get(nodeRef);
      const rawProjects = readDeezProjects(json);
      const merged = mergeDeezImport([...(yield* Ref.get(projectsRef)).values()], rawProjects, {
        nodeName: node.nodeName,
        nowIso: yield* nowIso,
      });
      if (merged.upserts.length > 0) {
        yield* write(
          `Import ${merged.imported} new, ${merged.updated} updated projects from Deez-Project-Manager`,
          Effect.forEach(merged.upserts, saveProject, { discard: true }),
        );
        yield* refreshGlances;
      }
      const tasksMerged = mergeDeezTasks(
        [...(yield* Ref.get(tasksRef)).values()],
        readDeezTasks(json),
        deezUuidToHubSlug(rawProjects),
      );
      if (tasksMerged.upserts.length > 0) {
        yield* write(
          `Import ${tasksMerged.imported} board tasks from Deez-Project-Manager`,
          Effect.forEach(tasksMerged.upserts, saveTask, { discard: true }),
        );
        yield* Ref.update(boardRevisionRef, (revision) => revision + 1);
        const touchedProjects = new Set(tasksMerged.upserts.map((task) => task.projectId));
        for (const projectId of touchedProjects) yield* notifyBoard(projectId);
      }
      if (merged.upserts.length > 0 || tasksMerged.upserts.length > 0) yield* notify;
      return {
        imported: merged.imported + tasksMerged.imported,
        updated: merged.updated,
        skipped: merged.skipped + tasksMerged.skipped,
      };
    }, writeLock.withPermits(1));

    const importProjects: CodrHubService["Service"]["importProjects"] = (input) =>
      input.source === "t3"
        ? Ref.get(nodeRef).pipe(
            // The manual button stays a one-way import until Sync with T3 is on.
            Effect.flatMap((node) => syncWithT3({ toT3: node.syncT3 === true })),
            writeLock.withPermits(1),
          )
        : importDeezProjects(input);

    const runSync = Effect.fn("codrHub.runSync")(function* (input: HubSyncInput) {
      if (input.remote !== undefined && input.remote !== (yield* io(Store.readRemote(paths)))) {
        const { node, records } = yield* ledgerState;
        if (node.autopilotEnabled || records.some((entry) => entry.running || entry.awaiting)) {
          return yield* new HubError({
            message:
              "Turn off Autopilot and settle or archive its finished threads before changing the portfolio remote.",
          });
        }
        if ((yield* io(Store.readRemote(paths))) !== null) {
          if (quotaNodeId === null)
            return yield* new HubError({
              message: "Repair this node's quota identity before changing the portfolio remote.",
            });
          yield* io(Quota.releaseOwned(paths, quotaNodeId));
        }
        yield* Ref.set(quotaRef, new Map());
        yield* Ref.set(releaseQuotaPending, true);
        yield* io(Store.setRemote(paths, input.remote));
      }
      const remote = yield* io(Store.readRemote(paths));
      if (remote === null) {
        yield* Ref.set(syncRef, { lastSyncAt: null, lastError: null });
        yield* notify;
        return;
      }
      const result = yield* io(Store.syncPortfolio(paths)).pipe(Effect.result);
      // A pull can succeed before a push fails. Keep queued edits based on
      // the disk state in that case too, without reading a manual git conflict.
      const reloaded = yield* io(Store.ensurePortfolioIdle(paths)).pipe(
        Effect.andThen(loadFromDisk),
        Effect.result,
      );
      if (reloaded._tag === "Success") {
        yield* Ref.set(hubRef, reloaded.success.hub);
        yield* Ref.set(
          projectsRef,
          new Map(reloaded.success.projects.map((project) => [project.id, project])),
        );
        yield* Ref.set(
          handoffsRef,
          new Map(reloaded.success.handoffs.map((handoff) => [handoff.projectId, handoff])),
        );
        yield* Ref.set(tasksRef, new Map(reloaded.success.tasks.map((task) => [task.id, task])));
        yield* Ref.update(boardRevisionRef, (revision) => revision + 1);
        const projectIds = new Set(reloaded.success.tasks.map((task) => task.projectId));
        for (const projectId of projectIds) yield* notifyBoard(projectId);
      }
      const error =
        result._tag === "Failure"
          ? result.failure.message
          : reloaded._tag === "Failure"
            ? reloaded.failure.message
            : null;
      if (error !== null) {
        yield* Ref.update(syncRef, (sync) => ({ ...sync, lastError: error }));
      } else {
        yield* Ref.set(syncRef, { lastSyncAt: yield* nowIso, lastError: null });
      }
      yield* notify;
    }, writeLock.withPermits(1));

    const sync: CodrHubService["Service"]["sync"] = Effect.fn("codrHub.sync")(function* (
      input: Parameters<CodrHubService["Service"]["sync"]>[0],
    ) {
      yield* runSync(input);
      const state = yield* Ref.get(syncRef);
      return {
        portfolioPath: paths.portfolioDir,
        remote: yield* io(Store.readRemote(paths)),
        lastSyncAt: state.lastSyncAt,
        lastError: state.lastError,
      };
    }, autopilotLock.withPermits(1));

    const verifyQuota = Effect.fn("codrHub.verifyQuota")(function* (provider: ServerProvider) {
      if ((yield* io(Store.readRemote(paths))) === null) return true;
      const key = Quota.accountKey(provider);
      let status: { allowed: boolean; reason: string };
      if (quotaNodeId === null) {
        status = {
          allowed: false,
          reason: "Quota coordination is unavailable: repair this node's quota identity.",
        };
      } else if (key === null) {
        status = {
          allowed: false,
          reason:
            "Shared pacing needs an authenticated account email from this provider. Sign in or use this provider on a local-only node.",
        };
      } else {
        const node = yield* Ref.get(nodeRef);
        const owner = yield* io(
          Quota.claim(paths, key, { version: 1, nodeId: quotaNodeId, nodeName: node.nodeName }),
        ).pipe(Effect.result);
        status =
          owner._tag === "Failure"
            ? { allowed: false, reason: owner.failure.message }
            : owner.success.nodeId === quotaNodeId
              ? { allowed: true, reason: `Pacing owner: ${node.nodeName}.` }
              : {
                  allowed: false,
                  reason: `Pacing is owned by ${owner.success.nodeName}. Turn off its Autopilot and drain its threads to hand over.`,
                };
        yield* Ref.set(releaseQuotaPending, true);
      }
      yield* Ref.update(quotaRef, (current) => new Map(current).set(quotaGroup(provider), status));
      return status.allowed;
    }, writeLock.withPermits(1));

    const releaseQuotaWhenIdle = autopilotLock.withPermits(1)(
      Effect.gen(function* () {
        if (!(yield* Ref.get(releaseQuotaPending))) return;
        const { node, records } = yield* ledgerState;
        if (node.autopilotEnabled) return;
        if (records.some((entry) => entry.running || entry.awaiting)) {
          yield* Ref.set(
            noteRef,
            "Autopilot is off. Pacing ownership stays here until its threads finish and are settled or archived.",
          );
          yield* notify;
          return;
        }
        const result = yield* writeLock
          .withPermits(1)(
            Effect.gen(function* () {
              if ((yield* io(Store.readRemote(paths))) === null) return 0;
              if (quotaNodeId === null)
                return yield* new HubError({
                  message:
                    "Could not release pacing ownership: this node's quota identity is unavailable.",
                });
              return yield* io(Quota.releaseOwned(paths, quotaNodeId));
            }),
          )
          .pipe(Effect.result);
        if (result._tag === "Failure") {
          yield* Ref.set(noteRef, result.failure.message);
        } else {
          yield* Ref.set(releaseQuotaPending, false);
          yield* Ref.set(quotaRef, new Map());
          if (result.success > 0)
            yield* Ref.set(noteRef, "Pacing ownership released. Another node can now take over.");
        }
        yield* notify;
      }),
    );

    const resolveT3Project = Effect.fn("codrHub.resolveT3Project")(function* (
      hubProject: HubProject,
      workspaceRoot: string,
    ) {
      const existing = yield* projectsService.getByWorkspaceRoot(workspaceRoot);
      if (Option.isSome(existing)) return existing.value;
      const { project } = yield* projectsService.bootstrap({
        commandId: CommandId.make(`codr-hub:project:${yield* uuid}`),
        projectId: ProjectId.make(yield* uuid),
        title: hubProject.name,
        workspaceRoot,
      });
      return project;
    });

    const launchError = (view: HubProjectView) => (cause: unknown) =>
      isHubError(cause)
        ? cause
        : new HubError({ message: `Could not launch ${view.project.name}.`, cause });

    /** Checks a project can launch on this provider. Dispatches no thread. */
    const planLaunch = Effect.fn("codrHub.planLaunch")(
      function* (
        view: HubProjectView,
        provider: ServerProvider,
        paced: ReadonlyArray<{
          readonly provider: ServerProvider;
          readonly decision: PaceDecision;
        }>,
      ) {
        const hub = yield* Ref.get(hubRef);
        const { project } = view;
        const workspaceRoot = view.localPath!;
        const autonomy = project.autonomy as Exclude<HubAutonomy, 0>;
        const settings = launchSettingsFor(autonomy);
        const git = settings.worktree ? yield* glance(workspaceRoot) : null;
        if (settings.worktree && git === null) {
          return yield* new HubError({ message: `${project.name} is not a git repository.` });
        }
        const rows = paced.map(({ provider: pacedProvider, decision }) => ({
          instanceId: pacedProvider.instanceId,
          driver: pacedProvider.driver,
          models: pacedProvider.models.map((model) => model.slug),
          pace: {
            state: decision.pace.state,
            resetsAt: decision.pace.resetsAt,
            usedPercent: decision.pace.usedPercent,
          },
        }));
        const candidate = rows.find((row) => row.instanceId === provider.instanceId);
        const choice =
          candidate === undefined
            ? { _tag: "NotNow" as const }
            : selectLaunchModel({
                jobKind: project.jobKind,
                handoff: view.handoff,
                candidate,
                providers: rows,
                codexTargetPercent: paceTargetFor(hub.settings, ProviderDriverKind.make("codex")),
              });
        if (choice._tag === "NotNow") return { _tag: "NotNow" as const };
        const t3Project = yield* resolveT3Project(project, workspaceRoot);
        const modelSelection: ModelSelection = {
          instanceId: choice.instanceId,
          model: choice.model,
          ...(choice.options.length > 0 ? { options: [...choice.options] } : {}),
        };
        const id = yield* uuid;
        const now = yield* nowIso;
        const record: Store.NodeLaunchRecord = {
          threadId: ThreadId.make(`codr-hub:${id}`),
          hubProjectId: project.id,
          t3ProjectId: t3Project.id,
          instanceId: provider.instanceId,
          quotaAccountKey: Quota.accountKey(provider) ?? undefined,
          stage: project.stage,
          autonomy,
          launchedAt: now,
        };
        const strategyTitle =
          hub.strategy.find((priority) => priority.id === project.strategyId)?.title ?? null;
        const stagePrompt = buildAutopilotPrompt({
          project,
          mode: hub.settings.sdlcMode,
          stagePrompts: hub.settings.stagePrompts,
          strategyTitle,
        });
        const fix = view.handoff?.kind === "fix" ? view.handoff : null;
        const text = fix
          ? `${fix.note}\n\nFollow poteto-mode.`
          : choice.promptSuffix === null
            ? stagePrompt
            : `${stagePrompt}\n\n${choice.promptSuffix}`;
        const input: ThreadLaunchService.ThreadLaunchInput = {
          commandId: CommandId.make(`codr-hub:launch:${id}`),
          threadId: record.threadId,
          projectId: t3Project.id,
          title: `Autopilot: ${project.name} (${stageLabel(project.stage, hub.settings.sdlcMode)})`,
          modelSelection,
          runtimeMode: settings.runtimeMode,
          interactionMode: settings.interactionMode,
          workspaceStrategy: settings.worktree
            ? {
                type: "worktree",
                baseRef: git?.branch ?? "HEAD",
                branch: `codr-hub/${project.id}-${project.stage}-${now.slice(0, 16).replace(/[-:T]/g, "")}`,
              }
            : { type: "root" },
          initialMessage: {
            messageId: MessageId.make(`codr-hub-message:${id}`),
            text,
            attachments: [],
          },
          createdBy: "system",
          creationSource: "server",
        };
        return {
          _tag: "Ready" as const,
          record,
          input,
          restoreFix: fix,
        };
      },
      (effect, view) => effect.pipe(Effect.mapError(launchError(view))),
    );

    const dispatchLaunch = Effect.fn("codrHub.dispatchLaunch")(
      function* (
        view: HubProjectView,
        plan: {
          readonly record: Store.NodeLaunchRecord;
          readonly input: ThreadLaunchService.ThreadLaunchInput;
          readonly restoreFix: Extract<TestHandoff, { kind: "fix" }> | null;
        },
      ) {
        const { record } = plan;
        const { records } = yield* ledgerState;
        const retained = new Set(
          records
            .filter((entry) => entry.running || entry.awaiting)
            .map((entry) => entry.record.threadId),
        );
        // Persist before dispatch: a lost launch reply must not let another
        // node take ownership while the launched thread is still running.
        yield* saveNode((node) => {
          const recent = new Set(
            node.ledger.slice(-(LEDGER_LIMIT - 1)).map((entry) => entry.threadId),
          );
          return {
            ...node,
            ledger: [
              ...node.ledger.filter(
                (entry) => retained.has(entry.threadId) || recent.has(entry.threadId),
              ),
              record,
            ],
          };
        });
        if (plan.restoreFix) {
          const consumed = reduceTestHandoff(plan.restoreFix, {
            type: "consumed",
            byThreadId: record.threadId,
            updatedAt: record.launchedAt,
          });
          if (consumed !== null && consumed !== plan.restoreFix) {
            yield* write(`Record fix launch for ${view.project.name}`, saveHandoff(consumed));
          }
        }
        const launched = yield* threadLaunch.launch(plan.input).pipe(Effect.result);
        if (launched._tag === "Failure") {
          if (plan.restoreFix) {
            yield* write(
              `Restore fix note for ${view.project.name}`,
              saveHandoff(plan.restoreFix),
            ).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Codr-Hub could not restore the fix note", { cause }),
              ),
            );
          }
          return yield* launchError(view)(launched.failure);
        }
        return record;
      },
      (effect, view) => effect.pipe(Effect.mapError(launchError(view))),
    );

    /**
     * One pass: deploy banked resets the owner opted into, then fill each
     * behind-pace provider up to its desired concurrency with the top-ranked
     * eligible projects. `force` launches one thread on the most suitable
     * provider even when everything is on pace.
     */
    const autopilotPass = (force: boolean) =>
      autopilotLock.withPermits(1)(
        Effect.gen(function* () {
          const hub = yield* Ref.get(hubRef);
          const notes: string[] = [];
          const launched: HubLaunchRecord[] = [];
          const decisions = yield* paceDecisions;
          const granted = new Set<string>();
          const permit = Effect.fn("codrHub.permit")(function* (provider: ServerProvider) {
            const group = quotaGroup(provider);
            if (granted.has(group)) return true;
            const allowed = yield* verifyQuota(provider);
            if (allowed) granted.add(group);
            else notes.push((yield* Ref.get(quotaRef)).get(group)!.reason);
            return allowed;
          });

          const resets = new Set<string>();
          for (const { provider, decision } of decisions) {
            if (!decision.deployBankedReset) continue;
            const group = quotaGroup(provider);
            if (resets.has(group)) continue;
            resets.add(group);
            const instance = yield* instances.getInstance(provider.instanceId);
            if (!instance?.consumeResetCredit) continue;
            if (!(yield* permit(provider))) continue;
            const outcome = yield* instance.consumeResetCredit().pipe(Effect.result);
            notes.push(
              outcome._tag === "Success"
                ? `Deployed a banked reset on ${providerLabel(provider)} (${outcome.success}).`
                : `Could not deploy a banked reset on ${providerLabel(provider)}.`,
            );
          }

          const { views, records } = yield* buildViews;
          let budget =
            hub.settings.maxConcurrentRuns - records.filter((entry) => entry.running).length;
          const order = (d: PaceDecision) => d.pace.desiredConcurrency - d.pace.running;
          const candidates = decisions
            .filter(({ decision }) =>
              force
                ? decision.pace.state === "behind" || decision.pace.state === "on_pace"
                : decision.pace.state === "behind",
            )
            .toSorted((a, b) => order(b.decision) - order(a.decision));
          if (candidates.length === 0) {
            notes.push(
              decisions.length === 0
                ? "No enabled providers."
                : "No provider is behind pace; nothing to spend right now.",
            );
          }
          const outstanding = new Set(
            records.filter((entry) => entry.outstanding).map((entry) => entry.record.threadId),
          );
          const blocked = new Set<string>();
          const accounts = new Set<string>();
          outer: for (const { provider, decision } of candidates) {
            const group = quotaGroup(provider);
            if (accounts.has(group)) continue;
            accounts.add(group);
            let slots = force ? 1 : order(decision);
            if (slots <= 0 || budget <= 0) continue;
            const skippedHere = new Set<string>();
            const exclude = () => new Set([...blocked, ...skippedHere]);
            if (pickNextProject(views, hub.strategy, exclude(), outstanding) === null) {
              notes.push("No eligible project.");
              break;
            }
            if (!(yield* permit(provider))) continue;
            while (slots > 0 && budget > 0) {
              const view = pickNextProject(views, hub.strategy, exclude(), outstanding);
              if (view === null) {
                if (pickNextProject(views, hub.strategy, blocked, outstanding) === null) {
                  const sample = views.find((candidate) => !blocked.has(candidate.project.id));
                  notes.push(
                    sample
                      ? `No eligible project (e.g. ${sample.project.name}: ${ineligibleReason(sample, outstanding)}).`
                      : "No eligible project.",
                  );
                  break outer;
                }
                break;
              }
              const plan = yield* planLaunch(view, provider, decisions).pipe(Effect.result);
              if (plan._tag === "Failure") {
                // Nothing was dispatched, so one broken project must not
                // block the rest of the portfolio. Try the next one.
                blocked.add(view.project.id);
                notes.push(plan.failure.message);
                continue;
              }
              if (plan.success._tag === "NotNow") {
                skippedHere.add(view.project.id);
                continue;
              }
              blocked.add(view.project.id);
              const result = yield* dispatchLaunch(view, plan.success).pipe(Effect.result);
              if (result._tag === "Failure") {
                notes.push(result.failure.message);
                // A failed reply can follow a committed dispatch. Recheck
                // durable thread state next pass before spending more slots.
                break outer;
              }
              launched.push(result.success);
              notes.push(`Launched ${view.project.name} on ${providerLabel(provider)}.`);
              slots -= 1;
              budget -= 1;
              if (force) break outer;
            }
          }
          if (budget <= 0 && launched.length === 0) notes.push("All autopilot slots are busy.");
          yield* Ref.set(noteRef, notes.join(" ") || null);
          yield* notify;
          return { launched, notes };
        }),
      );

    const runAutopilot: CodrHubService["Service"]["runAutopilot"] = () => autopilotPass(true);

    const armFinishedHandoffs = Effect.gen(function* () {
      const { node, records } = yield* ledgerState;
      const mode = (yield* Ref.get(hubRef)).settings.sdlcMode;
      const stored = yield* Ref.get(handoffsRef);
      const now = yield* nowIso;
      const byProject = new Map<string, typeof records>();
      for (const entry of records) {
        if (!entry.finished || entry.record.stage !== ownerTryStage(mode)) continue;
        const list = byProject.get(entry.record.hubProjectId) ?? [];
        list.push(entry);
        byProject.set(entry.record.hubProjectId, list);
      }
      const updates: TestHandoff[] = [];
      for (const [projectId, entries] of byProject) {
        let next = stored.get(projectId) ?? null;
        const started = next;
        const ordered = [...entries].sort((left, right) =>
          left.record.launchedAt < right.record.launchedAt
            ? -1
            : left.record.launchedAt > right.record.launchedAt
              ? 1
              : 0,
        );
        for (const entry of ordered) {
          next = reduceTestHandoff(next, {
            type: "threadFinished",
            projectId,
            threadId: entry.record.threadId,
            stage: entry.record.stage,
            mode,
            nodeName: node.nodeName,
            finishedAt: now,
            updatedAt: now,
          });
        }
        if (next !== null && next !== started) updates.push(next);
      }
      if (updates.length === 0) return;
      yield* write("Record test handoff", Effect.forEach(updates, saveHandoff, { discard: true }));
    });

    const tick = Effect.gen(function* () {
      const now = yield* nowMs;
      const timers = yield* Ref.get(timersRef);
      const node = yield* Ref.get(nodeRef);
      yield* armFinishedHandoffs.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Codr-Hub test handoff was not recorded", { cause }),
        ),
      );
      if (now - timers.glance >= GLANCE_EVERY_MS) {
        yield* Ref.update(timersRef, (t) => ({ ...t, glance: now, refresh: now }));
        yield* refreshGlances;
        yield* publishFleetActivity;
        yield* notify;
      } else if (now - timers.refresh >= REFRESH_EVERY_MS) {
        // Usage and thread state move on their own; keep subscribers current.
        yield* Ref.update(timersRef, (t) => ({ ...t, refresh: now }));
        yield* publishFleetActivity;
        yield* notify;
      }
      if (now - timers.autopilot >= AUTOPILOT_EVERY_MS) {
        yield* Ref.update(timersRef, (t) => ({ ...t, autopilot: now }));
        // Launch failures are collected as notes inside the pass.
        if (node.autopilotEnabled) yield* autopilotPass(false);
        else yield* releaseQuotaWhenIdle;
      }
      if (now - timers.sync >= SYNC_EVERY_MS) {
        yield* Ref.update(timersRef, (t) => ({ ...t, sync: now }));
        yield* runSync({}).pipe(
          Effect.catch((cause) => Effect.logWarning("Codr-Hub sync failed", { cause })),
        );
      }
    });

    yield* publishFleetActivity;
    yield* scheduler.register("codr-hub", tick);
    if ((yield* Ref.get(nodeRef)).syncT3 === true) yield* watchT3(true);

    return CodrHubService.of({
      subscribe,
      subscribeBoard,
      applyBoard,
      upsertProject,
      upsertProjects,
      deleteProject,
      recordTestVerdict,
      setStrategy,
      updateSettings,
      setNode,
      importProjects,
      sync,
      runAutopilot,
      insights,
    });
  }),
);

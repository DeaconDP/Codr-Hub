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
  MessageId,
  ProjectId,
  ThreadId,
  type HubAutonomy,
  type HubDeleteProjectInput,
  type HubGitGlance,
  type HubImportInput,
  type HubImportResult,
  type HubLaunchRecord,
  type HubOk,
  type HubPace,
  type HubProject,
  type HubProjectView,
  type HubRunAutopilotResult,
  type HubSetNodeInput,
  type HubSetStrategyInput,
  type HubSnapshot,
  type HubSyncInput,
  type HubSyncStatus,
  type HubUpdateSettingsInput,
  type HubUpsertProjectInput,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ProcessRunner } from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { mergeDeezImport, readDeezProjects, slugifyProjectName } from "./deezImport.ts";
import { GIT_GLANCE_ARGS, parseGitGlance } from "./gitGlance.ts";
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

const AUTOPILOT_EVERY_MS = 60_000;
const GLANCE_EVERY_MS = 60_000;
const SYNC_EVERY_MS = 5 * 60_000;
const REFRESH_EVERY_MS = 20_000;
const LEDGER_LIMIT = 200;

export class CodrHubService extends Context.Service<
  CodrHubService,
  {
    readonly subscribe: () => Stream.Stream<HubSnapshot, HubError>;
    readonly upsertProject: (input: HubUpsertProjectInput) => Effect.Effect<HubOk, HubError>;
    readonly deleteProject: (input: HubDeleteProjectInput) => Effect.Effect<HubOk, HubError>;
    readonly setStrategy: (input: HubSetStrategyInput) => Effect.Effect<HubOk, HubError>;
    readonly updateSettings: (input: HubUpdateSettingsInput) => Effect.Effect<HubOk, HubError>;
    readonly setNode: (input: HubSetNodeInput) => Effect.Effect<HubOk, HubError>;
    readonly importProjects: (input: HubImportInput) => Effect.Effect<HubImportResult, HubError>;
    readonly sync: (input: HubSyncInput) => Effect.Effect<HubSyncStatus, HubError>;
    /** One autopilot pass now, launching at most one thread even when every provider is on pace. */
    readonly runAutopilot: () => Effect.Effect<HubRunAutopilotResult, HubError>;
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

const providerLabel = (provider: ServerProvider) => provider.displayName ?? provider.driver;
const quotaGroup = (provider: ServerProvider) =>
  Quota.accountKey(provider) ?? `instance:${provider.instanceId}`;

const isUsable = (provider: ServerProvider) =>
  provider.enabled &&
  provider.status !== "error" &&
  provider.status !== "disabled" &&
  provider.auth.status !== "unauthenticated";

const defaultModelFor = (provider: ServerProvider): ModelSelection | null => {
  const model =
    provider.models.find((candidate) => candidate.isDefault) ??
    provider.models.find((candidate) => !candidate.isLegacy) ??
    provider.models[0];
  return model ? { instanceId: provider.instanceId, model: model.slug } : null;
};

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
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const scheduler = yield* Scheduler.Scheduler;
    const platform = yield* HostProcessPlatform;

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
      }),
    );
    const initial = yield* loadFromDisk.pipe(
      Effect.catch((cause) =>
        Effect.logError("Codr-Hub could not read the portfolio; starting empty", { cause }).pipe(
          Effect.as({ hub: undefined, projects: [] as HubProject[] }),
        ),
      ),
    );
    const hubRef = yield* Ref.make(initial.hub ?? Store.EMPTY_HUB_FILE);
    const projectsRef = yield* Ref.make<ReadonlyMap<string, HubProject>>(
      new Map(initial.projects.map((project) => [project.id, project])),
    );
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

    const nowMs = Clock.currentTimeMillis;
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const uuid = crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) => new HubError({ message: "Could not generate an id.", cause })),
    );

    const localPathOf = (project: HubProject, nodeName: string) =>
      project.hosts[nodeName]?.path ?? null;

    // --- git glance and path checks -----------------------------------------

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
        return {
          record,
          running:
            shell !== undefined &&
            (shell.activeRunId !== null || (shell.pendingBackgroundTasks?.length ?? 0) > 0),
          // Archived or deleted threads drop out of the active snapshot.
          awaiting: shell !== undefined && shell.archivedAt === null && !isSettled(shell),
        };
      });
      return { node, records };
    });

    const buildViews = Effect.gen(function* () {
      const { node, records } = yield* ledgerState;
      const glances = yield* Ref.get(glancesRef);
      const exists = yield* Ref.get(existsRef);
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
              targetPercent: hub.settings.paceTargetPercent,
              maxConcurrentRuns: hub.settings.maxConcurrentRuns,
              autoDeployBankedResets: hub.settings.autoDeployBankedResets,
              nowMs: now,
            },
          ),
        }));
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

    // --- writes --------------------------------------------------------------

    /** Callers hold writeLock while reading the current snapshot and saving it. */
    const write = <A>(message: string, effect: Effect.Effect<A, HubError>) =>
      Effect.gen(function* () {
        yield* io(Store.ensurePortfolioIdle(paths));
        const result = yield* effect;
        yield* io(Store.commitPortfolio(paths, message)).pipe(
          Effect.catch((cause) => Effect.logWarning("Codr-Hub commit failed", { cause })),
        );
        return result;
      }).pipe(Effect.tap(() => notify));

    const saveProject = (project: HubProject) =>
      io(Store.writeProject(paths, project)).pipe(
        Effect.andThen(
          Ref.update(projectsRef, (current) => new Map(current).set(project.id, project)),
        ),
      );

    const saveNode = (update: (node: Store.NodeFile) => Store.NodeFile) =>
      Effect.gen(function* () {
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

    const upsertProject: CodrHubService["Service"]["upsertProject"] = (input) =>
      Effect.gen(function* () {
        const projects = yield* Ref.get(projectsRef);
        const node = yield* Ref.get(nodeRef);
        const now = yield* nowIso;
        const existing = input.id === undefined ? undefined : projects.get(input.id);
        if (input.id !== undefined && existing === undefined) {
          return yield* new HubError({ message: `Project ${input.id} not found.` });
        }
        if (existing === undefined && input.name === undefined) {
          return yield* new HubError({ message: "A new project needs a name." });
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
          createdAt: now,
          updatedAt: now,
        };
        const { id: _id, localPath, ...patch } = input;
        const hosts = { ...base.hosts };
        if (localPath === null) delete hosts[node.nodeName];
        else if (localPath !== undefined) hosts[node.nodeName] = { path: localPath };
        const next: HubProject = {
          ...base,
          ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
          hosts,
          updatedAt: now,
        };
        yield* write(`${existing ? "Update" : "Add"} ${next.name}`, saveProject(next));
        if (localPath !== undefined) yield* refreshGlances.pipe(Effect.andThen(notify));
        return OK;
      }).pipe(writeLock.withPermits(1));

    const deleteProject: CodrHubService["Service"]["deleteProject"] = (input) =>
      Effect.gen(function* () {
        const project = (yield* Ref.get(projectsRef)).get(input.id);
        if (!project) return OK;
        yield* write(
          `Remove ${project.name}`,
          io(Store.removeProject(paths, input.id)).pipe(
            Effect.andThen(
              Ref.update(projectsRef, (current) => {
                const next = new Map(current);
                next.delete(input.id);
                return next;
              }),
            ),
          ),
        );
        return OK;
      }).pipe(writeLock.withPermits(1));

    const setStrategy: CodrHubService["Service"]["setStrategy"] = (input) =>
      Effect.gen(function* () {
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
      }).pipe(writeLock.withPermits(1));

    const updateSettings: CodrHubService["Service"]["updateSettings"] = (input) =>
      Effect.gen(function* () {
        const hub = yield* Ref.get(hubRef);
        const patch = Object.fromEntries(
          Object.entries(input).filter(([, value]) => value !== undefined),
        );
        const next = { ...hub, settings: { ...hub.settings, ...patch } };
        yield* write(
          "Update hub settings",
          io(Store.writeHubFile(paths, next)).pipe(Effect.andThen(Ref.set(hubRef, next))),
        );
        return OK;
      }).pipe(writeLock.withPermits(1));

    const setNode: CodrHubService["Service"]["setNode"] = (input) =>
      Effect.gen(function* () {
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
        }));
        if (input.autopilotEnabled !== undefined) {
          yield* Ref.update(timersRef, (timers) => ({ ...timers, autopilot: 0 }));
          yield* Ref.set(releaseQuotaPending, true);
        }
        yield* notify;
        return OK;
      }).pipe(writeLock.withPermits(1), autopilotLock.withPermits(1));

    const importProjects: CodrHubService["Service"]["importProjects"] = (input) =>
      Effect.gen(function* () {
        const file = input.path ?? deezProjectManagerFile(path, platform);
        const text = yield* fs
          .readFileString(file)
          .pipe(
            Effect.mapError((cause) => new HubError({ message: `Could not read ${file}.`, cause })),
          );
        const json = yield* decodeJson(text).pipe(
          Effect.mapError(
            (cause) => new HubError({ message: `${file} is not valid JSON.`, cause }),
          ),
        );
        const node = yield* Ref.get(nodeRef);
        const merged = mergeDeezImport(
          [...(yield* Ref.get(projectsRef)).values()],
          readDeezProjects(json),
          {
            nodeName: node.nodeName,
            nowIso: yield* nowIso,
          },
        );
        if (merged.upserts.length > 0) {
          yield* write(
            `Import ${merged.imported} new, ${merged.updated} updated projects from Deez-Project-Manager`,
            Effect.forEach(merged.upserts, saveProject, { discard: true }),
          );
          yield* refreshGlances.pipe(Effect.andThen(notify));
        }
        return { imported: merged.imported, updated: merged.updated, skipped: merged.skipped };
      }).pipe(writeLock.withPermits(1));

    const runSync = (input: HubSyncInput = {}) =>
      Effect.gen(function* () {
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
      }).pipe(writeLock.withPermits(1));

    const sync: CodrHubService["Service"]["sync"] = (input) =>
      Effect.gen(function* () {
        yield* runSync(input);
        const state = yield* Ref.get(syncRef);
        return {
          portfolioPath: paths.portfolioDir,
          remote: yield* io(Store.readRemote(paths)),
          lastSyncAt: state.lastSyncAt,
          lastError: state.lastError,
        };
      }).pipe(autopilotLock.withPermits(1));

    // --- autopilot -----------------------------------------------------------

    const verifyQuota = (provider: ServerProvider) =>
      Effect.gen(function* () {
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
        yield* Ref.update(quotaRef, (current) =>
          new Map(current).set(quotaGroup(provider), status),
        );
        return status.allowed;
      }).pipe(writeLock.withPermits(1));

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

    const resolveT3Project = (hubProject: HubProject, workspaceRoot: string) =>
      Effect.gen(function* () {
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

    const launch = (view: HubProjectView, provider: ServerProvider) =>
      Effect.gen(function* () {
        const hub = yield* Ref.get(hubRef);
        const { project } = view;
        const workspaceRoot = view.localPath!;
        const autonomy = project.autonomy as Exclude<HubAutonomy, 0>;
        const settings = launchSettingsFor(autonomy);
        const git = settings.worktree ? yield* glance(workspaceRoot) : null;
        if (settings.worktree && git === null) {
          return yield* new HubError({ message: `${project.name} is not a git repository.` });
        }
        const t3Project = yield* resolveT3Project(project, workspaceRoot);
        const modelSelection =
          t3Project.defaultModelSelection?.instanceId === provider.instanceId
            ? t3Project.defaultModelSelection
            : defaultModelFor(provider);
        if (modelSelection === null) {
          return yield* new HubError({ message: `${providerLabel(provider)} has no models.` });
        }
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
        const strategyTitle =
          hub.strategy.find((priority) => priority.id === project.strategyId)?.title ?? null;
        yield* threadLaunch.launch({
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
            text: buildAutopilotPrompt({
              project,
              mode: hub.settings.sdlcMode,
              stagePrompts: hub.settings.stagePrompts,
              strategyTitle,
            }),
            attachments: [],
          },
          createdBy: "system",
          creationSource: "server",
        });
        return record;
      }).pipe(
        Effect.mapError((cause) =>
          isHubError(cause)
            ? cause
            : new HubError({ message: `Could not launch ${view.project.name}.`, cause }),
        ),
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
          const permit = (provider: ServerProvider) =>
            Effect.gen(function* () {
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
          const tried = new Set<string>();
          const accounts = new Set<string>();
          outer: for (const { provider, decision } of candidates) {
            const group = quotaGroup(provider);
            if (accounts.has(group)) continue;
            accounts.add(group);
            let slots = force ? 1 : order(decision);
            if (slots <= 0 || budget <= 0) continue;
            if (pickNextProject(views, hub.strategy, tried) === null) {
              notes.push("No eligible project.");
              break;
            }
            if (!(yield* permit(provider))) continue;
            while (slots > 0 && budget > 0) {
              const view = pickNextProject(views, hub.strategy, tried);
              if (view === null) {
                const sample = views.find((candidate) => !tried.has(candidate.project.id));
                notes.push(
                  sample
                    ? `No eligible project (e.g. ${sample.project.name}: ${ineligibleReason(sample)}).`
                    : "No eligible project.",
                );
                break outer;
              }
              tried.add(view.project.id);
              const result = yield* launch(view, provider).pipe(Effect.result);
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

    // --- scheduler -----------------------------------------------------------

    const tick = Effect.gen(function* () {
      const now = yield* nowMs;
      const timers = yield* Ref.get(timersRef);
      const node = yield* Ref.get(nodeRef);
      if (now - timers.glance >= GLANCE_EVERY_MS) {
        yield* Ref.update(timersRef, (t) => ({ ...t, glance: now, refresh: now }));
        yield* refreshGlances;
        yield* notify;
      } else if (now - timers.refresh >= REFRESH_EVERY_MS) {
        // Usage and thread state move on their own; keep subscribers current.
        yield* Ref.update(timersRef, (t) => ({ ...t, refresh: now }));
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
        yield* runSync().pipe(
          Effect.catch((cause) => Effect.logWarning("Codr-Hub sync failed", { cause })),
        );
      }
    });

    yield* scheduler.register("codr-hub", tick);

    return CodrHubService.of({
      subscribe,
      upsertProject,
      deleteProject,
      setStrategy,
      updateSettings,
      setNode,
      importProjects,
      sync,
      runAutopilot,
    });
  }),
);

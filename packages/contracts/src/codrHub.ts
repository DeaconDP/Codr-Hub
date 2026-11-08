/**
 * Codr-Hub portfolio and autopilot contracts. Records live as files in a git repo shared by
 * every mesh node, so they use stable string ids, not T3 entity ids.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AuthStandardClientScopes } from "./auth.ts";
import { ProjectIconColor } from "./project.ts";
import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/** Absent JSON keys decode to null so older portfolio files stay readable. */
const NullString = Schema.NullOr(Schema.String).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
);
const NullInt = Schema.NullOr(Schema.Int).pipe(Schema.withDecodingDefault(Effect.succeed(null)));

export const HubPriority = Schema.Literals(["none", "low", "medium", "high", "critical"]);
export type HubPriority = typeof HubPriority.Type;

export const HubProjectStatus = Schema.Literals(["idea", "active", "paused", "blocked", "done"]);
export type HubProjectStatus = typeof HubProjectStatus.Type;

/** Six fine stages; three-stage mode shows them in pairs (see `HUB_STAGE_GROUPS`). */
export const HubSdlcStage = Schema.Literals([
  "plan",
  "design",
  "develop",
  "test",
  "release",
  "maintain",
]);
export type HubSdlcStage = typeof HubSdlcStage.Type;

export const HubSdlcMode = Schema.Literals(["three", "six"]);
export type HubSdlcMode = typeof HubSdlcMode.Type;

export const HUB_STAGE_GROUPS = [
  { id: "plan-design", label: "Plan & Design", stages: ["plan", "design"] },
  { id: "dev-test", label: "Dev & Test", stages: ["develop", "test"] },
  { id: "maintain-improve", label: "Maintain & Improve", stages: ["release", "maintain"] },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  stages: ReadonlyArray<HubSdlcStage>;
}>;

export const HUB_STAGE_LABELS: Record<HubSdlcStage, string> = {
  plan: "Plan",
  design: "Design",
  develop: "Develop",
  test: "Test",
  release: "Release",
  maintain: "Maintain",
};

/** Autonomy, shown as a percentage. Each step maps to launch settings on the server. */
export const HubAutonomy = Schema.Literals([0, 25, 50, 75, 100]);
export type HubAutonomy = typeof HubAutonomy.Type;

export const HUB_AUTONOMY_LABELS: Record<HubAutonomy, string> = {
  0: "Off",
  25: "Plan",
  50: "Supervised",
  75: "Draft PR",
  100: "Full auto",
};

export const HubLane = Schema.Literals(["immersion", "automation", "publicity"]);
export type HubLane = typeof HubLane.Type;

export const HubJobKind = Schema.Literals(["dev", "edit", "writing", "image"]);
export type HubJobKind = typeof HubJobKind.Type;

/**
 * One folder as the disk scan last saw it; machine facts that each newer scan replaces. Plain
 * strings, so a new scanner value never makes a project file undecodable.
 */
export const HubCheckoutScan = Schema.Struct({
  /** YYYY-MM-DD */
  scannedAt: Schema.String,
  /** Private / Public / Other / Archive */
  category: Schema.String,
  /** Engine or platform lane (Unity, VRChat, Unreal, Web, …); not the Hub's `HubLane`. */
  engine: Schema.String,
  /** github / edgar / git-local / perforce / none */
  vcs: Schema.String,
  remote: NullString,
  branch: NullString,
  ahead: NullInt,
  behind: NullInt,
  dirty: NullInt,
  /** YYYY-MM-DD */
  lastActivity: NullString,
  sizeGb: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** duplicate, copy, half-copy, backup, at-risk, outside-workshop, third-party, legacy-path, stale-scan */
  flags: Schema.Array(Schema.String),
});
export type HubCheckoutScan = typeof HubCheckoutScan.Type;

export const HubOtherCheckout = Schema.Struct({
  path: TrimmedNonEmptyString,
  scan: HubCheckoutScan,
});
export type HubOtherCheckout = typeof HubOtherCheckout.Type;

export const HubProjectHost = Schema.Struct({
  path: TrimmedNonEmptyString,
  /** Dev server port on this node only; meaningless on other machines. */
  stickyPort: NullInt,
  /** Rebuild/run hint for this node's checkout. */
  launchCmd: NullString,
  /** Disk-scan facts for `path`. */
  scan: Schema.optional(HubCheckoutScan),
  /** More folders of this project on the same node (copies, backups, old locations). */
  otherCheckouts: Schema.optional(Schema.Array(HubOtherCheckout)),
});
export type HubProjectHost = typeof HubProjectHost.Type;

export const HubProject = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  priority: HubPriority,
  status: HubProjectStatus,
  stage: HubSdlcStage,
  strategyId: Schema.NullOr(TrimmedNonEmptyString),
  category: Schema.NullOr(TrimmedNonEmptyString),
  tags: Schema.Array(TrimmedNonEmptyString),
  repoUrl: Schema.NullOr(TrimmedNonEmptyString),
  /** Staging / preview site URL (shared product truth across the mesh). */
  previewUrl: NullString,
  /** Production site URL. */
  liveUrl: NullString,
  /** Optional product-family id for grouping later. */
  siteId: NullString,
  /**
   * Product face label (e.g. ios / site). Free string — not T3 `clientSurface`.
   */
  surface: NullString,
  notes: Schema.String,
  /** Local checkout per mesh node, keyed by node name. */
  hosts: Schema.Record(Schema.String, HubProjectHost),
  autonomy: HubAutonomy,
  /** Most autopilot threads that may wait for review at once. */
  reviewBudget: NonNegativeInt,
  sortIndex: Schema.Number,
  favorite: Schema.Boolean,
  archived: Schema.Boolean,
  lane: Schema.NullOr(HubLane).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  jobKind: HubJobKind.pipe(Schema.withDecodingDefault(Effect.succeed("dev" as const))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HubProject = typeof HubProject.Type;

export const HubStrategyPriority = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  notes: Schema.String,
});
export type HubStrategyPriority = typeof HubStrategyPriority.Type;

const HUB_PRIORITY_WEIGHT: Record<HubPriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  none: 0,
};

/** Portfolio rank: strategy order first, then priority, favourites, manual order, name. */
export function compareHubProjects(
  strategy: ReadonlyArray<HubStrategyPriority>,
): (a: HubProject, b: HubProject) => number {
  const rank = new Map(strategy.map((priority, index) => [priority.id, index]));
  const strategyRank = (project: HubProject) =>
    (project.strategyId === null ? undefined : rank.get(project.strategyId)) ??
    Number.POSITIVE_INFINITY;
  return (a, b) =>
    strategyRank(a) - strategyRank(b) ||
    HUB_PRIORITY_WEIGHT[b.priority] - HUB_PRIORITY_WEIGHT[a.priority] ||
    Number(b.favorite) - Number(a.favorite) ||
    a.sortIndex - b.sortIndex ||
    a.name.localeCompare(b.name);
}

/** Built-in autopilot instruction per stage; owners override them in hub settings. */
export const HUB_DEFAULT_STAGE_PROMPTS: Record<HubSdlcStage, string> = {
  plan: "Clarify the problem and the next outcome. Update or create ROADMAP.md (epics, `## Deferred`) and TODO.md (next concrete tasks).",
  design:
    "Design the next TODO.md item: interfaces, data, and UX, kept as small as the problem allows. Record decisions next to the code or in docs.",
  develop:
    "Take the top unchecked item in TODO.md and implement it with focused tests. Check it off when done.",
  test: "Find and fix the most likely defects in recent work: run the test suite, add missing tests for risky paths, and record anything deferred in ROADMAP.md.",
  release:
    "Prepare the next release: changelog, version, README accuracy, and anything a user needs to install or update.",
  maintain:
    "Keep the project healthy: update dependencies with care, fix reported bugs, and remove dead code. Note anything larger in ROADMAP.md.",
};

const HubPaceTarget = Schema.Number.check(Schema.isBetween({ minimum: 10, maximum: 100 }));

export const HubPaceTargets = Schema.Struct({
  claudeAgent: HubPaceTarget,
  cursor: HubPaceTarget,
  codex: HubPaceTarget,
});
export type HubPaceTargets = typeof HubPaceTargets.Type;

const DEFAULT_HUB_PACE_TARGETS: HubPaceTargets = {
  claudeAgent: 95,
  cursor: 95,
  codex: 95,
};

export const HubSettings = Schema.Struct({
  sdlcMode: HubSdlcMode,
  /** Share of each window the autopilot aims to have used at reset. */
  paceTargetPercent: Schema.Number.check(Schema.isBetween({ minimum: 10, maximum: 100 })),
  maxConcurrentRuns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  /** Redeem a banked reset only when the owner opts in and it would otherwise expire unused. */
  autoDeployBankedResets: Schema.Boolean,
  /** Per-stage prompt overrides; missing stages use the built-in template. */
  stagePrompts: Schema.Record(Schema.String, Schema.String),
  /** Pace target for Claude, Cursor, and Codex. Other drivers use `paceTargetPercent`. */
  paceTargets: HubPaceTargets.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_HUB_PACE_TARGETS)),
  ),
  /** Owner-picked machine colour per node name; unset nodes get an automatic one. */
  nodeColors: Schema.Record(Schema.String, ProjectIconColor).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type HubSettings = typeof HubSettings.Type;

export const DEFAULT_HUB_SETTINGS: HubSettings = {
  sdlcMode: "three",
  paceTargetPercent: 95,
  maxConcurrentRuns: 2,
  autoDeployBankedResets: false,
  stagePrompts: {},
  paceTargets: DEFAULT_HUB_PACE_TARGETS,
  nodeColors: {},
};

export const HubLaunchRecord = Schema.Struct({
  threadId: ThreadId,
  hubProjectId: TrimmedNonEmptyString,
  t3ProjectId: ProjectId,
  instanceId: ProviderInstanceId,
  stage: HubSdlcStage,
  autonomy: HubAutonomy,
  launchedAt: IsoDateTime,
});
export type HubLaunchRecord = typeof HubLaunchRecord.Type;

export const HubGitGlance = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  dirty: Schema.Boolean,
  ahead: NonNegativeInt,
  behind: NonNegativeInt,
  hasUpstream: Schema.Boolean,
  error: Schema.optional(Schema.String),
});
export type HubGitGlance = typeof HubGitGlance.Type;

const HandoffIdentity = {
  version: Schema.Literal(1),
  projectId: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
  sourceThreadId: ThreadId,
  sourceStage: HubSdlcStage,
  nodeName: Schema.String,
  finishedAt: IsoDateTime,
};

/** One project's test handoff. Cleared rows stay on disk so a later finish cannot reopen them. */
export const TestHandoff = Schema.Union([
  Schema.Struct({ ...HandoffIdentity, kind: Schema.Literal("ready") }),
  Schema.Struct({
    ...HandoffIdentity,
    kind: Schema.Literal("fix"),
    note: Schema.String.check(Schema.isMaxLength(500)),
    notedAt: IsoDateTime,
  }),
  Schema.Struct({
    ...HandoffIdentity,
    kind: Schema.Literal("cleared"),
    reason: Schema.Literal("ship"),
  }),
  Schema.Struct({
    ...HandoffIdentity,
    kind: Schema.Literal("cleared"),
    reason: Schema.Literal("consumed"),
    note: Schema.String,
    byThreadId: ThreadId,
  }),
]);
export type TestHandoff = typeof TestHandoff.Type;

export const HubProjectView = Schema.Struct({
  project: HubProject,
  /** Checkout on this node, if any. */
  localPath: Schema.NullOr(Schema.String),
  pathExists: Schema.Boolean,
  git: Schema.NullOr(HubGitGlance),
  /** Autopilot threads still waiting for review (not settled or archived). */
  awaitingReview: NonNegativeInt,
  running: NonNegativeInt,
  lastLaunchAt: Schema.NullOr(IsoDateTime),
  handoff: Schema.NullOr(TestHandoff).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type HubProjectView = typeof HubProjectView.Type;

export const HubPaceState = Schema.Literals(["behind", "on_pace", "capped", "unavailable"]);
export type HubPaceState = typeof HubPaceState.Type;

export const HubPace = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  label: Schema.String,
  state: HubPaceState,
  windowLabel: Schema.NullOr(Schema.String),
  usedPercent: Schema.NullOr(Schema.Number),
  targetPercent: Schema.NullOr(Schema.Number),
  resetsAt: Schema.NullOr(IsoDateTime),
  desiredConcurrency: NonNegativeInt,
  running: NonNegativeInt,
  bankedResets: NonNegativeInt,
  bankedResetExpiresAt: Schema.NullOr(IsoDateTime),
  reason: Schema.String,
});
export type HubPace = typeof HubPace.Type;

export const HubSyncStatus = Schema.Struct({
  portfolioPath: Schema.String,
  remote: Schema.NullOr(Schema.String),
  lastSyncAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
});
export type HubSyncStatus = typeof HubSyncStatus.Type;

/** This node's "Sync with T3": projects added, linked, skipped, and created in T3. */
export const HubT3SyncResult = Schema.Struct({
  imported: NonNegativeInt,
  updated: NonNegativeInt,
  skipped: NonNegativeInt,
  created: NonNegativeInt,
});
export type HubT3SyncResult = typeof HubT3SyncResult.Type;

/**
 * Where Sync with T3 reads projects: "auto" (the one linked environment on this machine, else
 * this server), "local" (this server), or a linked environment's id.
 */
export const HubT3Source = Schema.Union([Schema.Literals(["auto", "local"]), EnvironmentId]);
export type HubT3Source = typeof HubT3Source.Type;

export const HubT3SyncStatus = Schema.Struct({
  enabled: Schema.Boolean,
  lastSyncAt: Schema.NullOr(IsoDateTime),
  lastResult: Schema.NullOr(HubT3SyncResult),
  lastError: Schema.NullOr(Schema.String),
  source: Schema.optional(HubT3Source),
  /** Linked T3 environments the last sync read, each with the node name its projects took. */
  t3Sources: Schema.optional(
    Schema.Array(Schema.Struct({ environmentId: EnvironmentId, nodeName: Schema.String })),
  ),
});
export type HubT3SyncStatus = typeof HubT3SyncStatus.Type;

export const HubFleetPhase = Schema.Literals(["current", "waiting", "updating", "stuck"]);
export type HubFleetPhase = typeof HubFleetPhase.Type;

export const HubFleetReport = Schema.Struct({
  phase: HubFleetPhase,
  detail: Schema.String,
  sha: Schema.NullOr(Schema.String),
  at: IsoDateTime,
});
export type HubFleetReport = typeof HubFleetReport.Type;

export const HubTaskCounts = Schema.Struct({
  total: NonNegativeInt,
  done: NonNegativeInt,
});
export type HubTaskCounts = typeof HubTaskCounts.Type;

export const HubSnapshot = Schema.Struct({
  nodeName: Schema.String,
  autopilotEnabled: Schema.Boolean,
  autopilotNote: Schema.NullOr(Schema.String),
  settings: HubSettings,
  strategy: Schema.Array(HubStrategyPriority),
  projects: Schema.Array(HubProjectView),
  pace: Schema.Array(HubPace),
  recentLaunches: Schema.Array(HubLaunchRecord),
  sync: HubSyncStatus,
  deezProjectManagerPath: Schema.NullOr(Schema.String),
  fleet: Schema.optional(HubFleetReport),
  t3Sync: Schema.optional(HubT3SyncStatus),
  /** Board task counts by project id; projects without tasks are absent. */
  taskCounts: Schema.optional(Schema.Record(Schema.String, HubTaskCounts)),
});
export type HubSnapshot = typeof HubSnapshot.Type;

/**
 * One reporting node's derived checkout. `HubProjectView` stays this shape;
 * mesh UI overlays several of these under a shared `HubProject`.
 */
export type HubNodeCheckout = {
  readonly nodeName: string;
  readonly localPath: string | null;
  readonly pathExists: boolean;
  readonly git: HubGitGlance | null;
  readonly awaitingReview: number;
  readonly running: number;
  readonly lastLaunchAt: string | null;
};

/** Client-side union of live Hub rows. Not on the wire. */
export type HubMergedProjectView = {
  readonly project: HubProject;
  readonly handoff: TestHandoff | null;
  readonly nodes: ReadonlyArray<HubNodeCheckout>;
};

function preferHandoff(
  current: TestHandoff | null,
  incoming: TestHandoff | null,
): TestHandoff | null {
  if (incoming === null) return current;
  if (current === null || incoming.updatedAt > current.updatedAt) return incoming;
  return current;
}

/**
 * Union by `project.id`, overlaying per-node checkout state. Disagreeing clones keep the latest
 * `updatedAt` (ties keep the first). Eligibility stays this-node: another host's checkout never
 * makes the selected environment eligible.
 */
export function mergeHubProjectViews(
  snapshots: ReadonlyArray<HubSnapshot>,
): HubMergedProjectView[] {
  const byId = new Map<
    string,
    { project: HubProject; handoff: TestHandoff | null; nodes: Map<string, HubNodeCheckout> }
  >();
  for (const snapshot of snapshots) {
    for (const view of snapshot.projects) {
      const existing = byId.get(view.project.id);
      const nodes = existing?.nodes ?? new Map<string, HubNodeCheckout>();
      nodes.set(snapshot.nodeName, {
        nodeName: snapshot.nodeName,
        localPath: view.localPath,
        pathExists: view.pathExists,
        git: view.git,
        awaitingReview: view.awaitingReview,
        running: view.running,
        lastLaunchAt: view.lastLaunchAt,
      });
      const project =
        existing === undefined || view.project.updatedAt > existing.project.updatedAt
          ? view.project
          : existing.project;
      byId.set(view.project.id, {
        project,
        handoff: preferHandoff(existing?.handoff ?? null, view.handoff),
        nodes,
      });
    }
  }
  return [...byId.values()].map((entry) => ({
    project: entry.project,
    handoff: entry.handoff,
    nodes: [...entry.nodes.values()],
  }));
}

export function hubProjectViewForNode(
  merged: HubMergedProjectView,
  nodeName: string,
): HubProjectView {
  const node = merged.nodes.find((entry) => entry.nodeName === nodeName);
  return {
    project: merged.project,
    localPath: node?.localPath ?? null,
    pathExists: node?.pathExists ?? false,
    git: node?.git ?? null,
    awaitingReview: node?.awaitingReview ?? 0,
    running: node?.running ?? 0,
    lastLaunchAt: node?.lastLaunchAt ?? null,
    handoff: merged.handoff,
  };
}

export function projectMatchesLane(
  project: { readonly lane: HubLane | null },
  lane: HubLane | null,
): boolean {
  return lane === null || project.lane === lane;
}

export function paceTargetFor(settings: HubSettings, driver: ProviderDriverKind): number {
  switch (driver) {
    case "claudeAgent":
      return settings.paceTargets.claudeAgent;
    case "cursor":
      return settings.paceTargets.cursor;
    case "codex":
      return settings.paceTargets.codex;
    default:
      return settings.paceTargetPercent;
  }
}

export function mergedProjectLastLaunchAt(merged: HubMergedProjectView): string | null {
  let best: string | null = null;
  for (const node of merged.nodes) {
    if (node.lastLaunchAt !== null && (best === null || node.lastLaunchAt > best)) {
      best = node.lastLaunchAt;
    }
  }
  return best;
}

export const HubSubscribeInput = Schema.Struct({});
export type HubSubscribeInput = typeof HubSubscribeInput.Type;

/** Create when `id` is absent, otherwise patch. `localPath` / sticky / launch set this node's host. */
export const HubUpsertProjectInput = Schema.Struct({
  id: Schema.optional(TrimmedNonEmptyString),
  name: Schema.optional(TrimmedNonEmptyString),
  priority: Schema.optional(HubPriority),
  status: Schema.optional(HubProjectStatus),
  stage: Schema.optional(HubSdlcStage),
  strategyId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  category: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  tags: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  repoUrl: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  previewUrl: Schema.optional(Schema.NullOr(Schema.String)),
  liveUrl: Schema.optional(Schema.NullOr(Schema.String)),
  siteId: Schema.optional(Schema.NullOr(Schema.String)),
  surface: Schema.optional(Schema.NullOr(Schema.String)),
  notes: Schema.optional(Schema.String),
  localPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  stickyPort: Schema.optional(Schema.NullOr(Schema.Int)),
  launchCmd: Schema.optional(Schema.NullOr(Schema.String)),
  autonomy: Schema.optional(HubAutonomy),
  reviewBudget: Schema.optional(NonNegativeInt),
  sortIndex: Schema.optional(Schema.Number),
  favorite: Schema.optional(Schema.Boolean),
  archived: Schema.optional(Schema.Boolean),
  lane: Schema.optional(Schema.NullOr(HubLane)),
  jobKind: Schema.optional(HubJobKind),
});
export type HubUpsertProjectInput = typeof HubUpsertProjectInput.Type;

/** Several upserts in one portfolio commit, such as a manual reorder. */
export const HubUpsertProjectsInput = Schema.Struct({
  projects: Schema.Array(HubUpsertProjectInput).check(Schema.isMaxLength(500)),
});
export type HubUpsertProjectsInput = typeof HubUpsertProjectsInput.Type;

export const HubDeleteProjectInput = Schema.Struct({ id: TrimmedNonEmptyString });
export type HubDeleteProjectInput = typeof HubDeleteProjectInput.Type;

/** Replaces the whole ordered list, so reordering is one write. */
export const HubSetStrategyInput = Schema.Struct({ strategy: Schema.Array(HubStrategyPriority) });
export type HubSetStrategyInput = typeof HubSetStrategyInput.Type;

export const HubUpdateSettingsInput = Schema.Struct({
  sdlcMode: Schema.optional(HubSdlcMode),
  paceTargetPercent: Schema.optional(HubSettings.fields.paceTargetPercent),
  maxConcurrentRuns: Schema.optional(HubSettings.fields.maxConcurrentRuns),
  autoDeployBankedResets: Schema.optional(Schema.Boolean),
  stagePrompts: Schema.optional(HubSettings.fields.stagePrompts),
  paceTargets: Schema.optional(
    Schema.Struct({
      claudeAgent: Schema.optional(HubPaceTarget),
      cursor: Schema.optional(HubPaceTarget),
      codex: Schema.optional(HubPaceTarget),
    }),
  ),
  /** Patch per node name; `null` returns that node to its automatic colour. */
  nodeColors: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(ProjectIconColor))),
});

export const HubRecordTestVerdictInput = Schema.Union([
  Schema.Struct({
    projectId: TrimmedNonEmptyString,
    verdict: Schema.Literal("ship"),
  }),
  Schema.Struct({
    projectId: TrimmedNonEmptyString,
    verdict: Schema.Literal("fix"),
    note: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  }),
]);
export type HubRecordTestVerdictInput = typeof HubRecordTestVerdictInput.Type;
export type HubUpdateSettingsInput = typeof HubUpdateSettingsInput.Type;

export const HubSetNodeInput = Schema.Struct({
  nodeName: Schema.optional(TrimmedNonEmptyString),
  autopilotEnabled: Schema.optional(Schema.Boolean),
  /** Keep this node's T3 projects and Hub checkouts in step automatically. */
  syncT3: Schema.optional(Schema.Boolean),
  t3Source: Schema.optional(HubT3Source),
});
export type HubSetNodeInput = typeof HubSetNodeInput.Type;

export const HubImportInput = Schema.Union([
  Schema.Struct({
    source: Schema.Literal("deez-project-manager"),
    /** Defaults to Deez-PM's app-data file on this machine. */
    path: Schema.optional(TrimmedNonEmptyString),
  }),
  /**
   * This node's T3 projects: links matching portfolio projects, adds the rest.
   * With Sync with T3 on, also adds this node's Hub checkouts to T3.
   */
  Schema.Struct({ source: Schema.Literal("t3") }),
  /**
   * A disk-scan TSV: `text` (an uploaded file), `path` (a file on this server's machine), or
   * `scanThisMachine` (scan now with this node's scan settings). Exactly one of the three.
   */
  Schema.Struct({
    source: Schema.Literal("scan"),
    text: Schema.optional(Schema.String.check(Schema.isMaxLength(8_000_000))),
    path: Schema.optional(TrimmedNonEmptyString),
    scanThisMachine: Schema.optional(Schema.Boolean),
    /** Hub machine for every row; otherwise each row's `nickname` must name a Hub machine. */
    nodeName: Schema.optional(TrimmedNonEmptyString),
    /** Report what would change without writing. */
    dryRun: Schema.optional(Schema.Boolean),
  }),
]);
export type HubImportInput = typeof HubImportInput.Type;

export const HubImportResult = Schema.Struct({
  imported: NonNegativeInt,
  updated: NonNegativeInt,
  skipped: NonNegativeInt,
  /** T3 projects created from Hub checkouts (Sync with T3 only). */
  created: Schema.optional(NonNegativeInt),
  /** Scan import only: rows read, projects matched, machine checkouts added, and what needs a look. */
  rows: Schema.optional(NonNegativeInt),
  matched: Schema.optional(NonNegativeInt),
  hostsAdded: Schema.optional(NonNegativeInt),
  ambiguous: Schema.optional(Schema.Array(Schema.String)),
  dryRun: Schema.optional(Schema.Boolean),
});
export type HubImportResult = typeof HubImportResult.Type;

export const HubSyncInput = Schema.Struct({
  /** Sets or clears the git remote before syncing. */
  remote: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type HubSyncInput = typeof HubSyncInput.Type;

export const HubRunAutopilotInput = Schema.Struct({});
export type HubRunAutopilotInput = typeof HubRunAutopilotInput.Type;

export const HubRunAutopilotResult = Schema.Struct({
  launched: Schema.Array(HubLaunchRecord),
  notes: Schema.Array(Schema.String),
});
export type HubRunAutopilotResult = typeof HubRunAutopilotResult.Type;

const scopeLiteral = <const S extends string>(scope: S) => Schema.Literal(scope);

/** The link carries `AuthStandardClientScopes` and nothing else. */
export const TailnetLinkScopes = Schema.Tuple([
  scopeLiteral(AuthStandardClientScopes[0]),
  scopeLiteral(AuthStandardClientScopes[1]),
  scopeLiteral(AuthStandardClientScopes[2]),
  scopeLiteral(AuthStandardClientScopes[3]),
  scopeLiteral(AuthStandardClientScopes[4]),
  scopeLiteral(AuthStandardClientScopes[5]),
  scopeLiteral(AuthStandardClientScopes[6]),
  scopeLiteral(AuthStandardClientScopes[7]),
  scopeLiteral(AuthStandardClientScopes[8]),
  scopeLiteral(AuthStandardClientScopes[9]),
  scopeLiteral(AuthStandardClientScopes[10]),
  scopeLiteral(AuthStandardClientScopes[11]),
  scopeLiteral(AuthStandardClientScopes[12]),
  scopeLiteral(AuthStandardClientScopes[13]),
  scopeLiteral(AuthStandardClientScopes[14]),
  scopeLiteral(AuthStandardClientScopes[15]),
]);
export type TailnetLinkScopes = typeof TailnetLinkScopes.Type;

type TailnetScopesMatch = TailnetLinkScopes extends typeof AuthStandardClientScopes
  ? typeof AuthStandardClientScopes extends TailnetLinkScopes
    ? true
    : never
  : never;
true satisfies TailnetScopesMatch;

export const TailnetLink = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  accessToken: Schema.String,
  scopes: TailnetLinkScopes,
});
export type TailnetLink = typeof TailnetLink.Type;

export const HubLinkTailnetInput = Schema.Struct({});
export type HubLinkTailnetInput = typeof HubLinkTailnetInput.Type;

export const HubLinkTailnetResult = Schema.Struct({
  links: Schema.Array(TailnetLink),
});
export type HubLinkTailnetResult = typeof HubLinkTailnetResult.Type;

export const HubOk = Schema.Struct({ ok: Schema.Literal(true) });
export type HubOk = typeof HubOk.Type;

export class HubError extends Schema.TaggedError<HubError>()("HubError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** What a checkout is built with. Detected from tags first, then the checkout's files. */
export const HubPlatform = Schema.Literals([
  "unreal",
  "unity",
  "ios",
  "android",
  "web",
  "desktop",
  "python",
  "rust",
  "other",
]);
export type HubPlatform = typeof HubPlatform.Type;

export const HUB_PLATFORM_LABELS: Record<HubPlatform, string> = {
  unreal: "Unreal",
  unity: "Unity",
  ios: "iOS",
  android: "Android",
  web: "Web",
  desktop: "Desktop",
  python: "Python",
  rust: "Rust",
  other: "Other",
};

/** Rolling dashboard windows, ending now. */
export const HubActivityWindow = Schema.Literals([
  "24h",
  "7d",
  "14d",
  "21d",
  "1m",
  "3m",
  "6m",
  "1y",
  "all",
]);
export type HubActivityWindow = typeof HubActivityWindow.Type;

/** Window length in days; `all` has none. `1m` is 30 days, `3m` 91, `6m` 182, `1y` 365. */
export const HUB_ACTIVITY_WINDOW_DAYS: Record<HubActivityWindow, number | null> = {
  "24h": 1,
  "7d": 7,
  "14d": 14,
  "21d": 21,
  "1m": 30,
  "3m": 91,
  "6m": 182,
  "1y": 365,
  all: null,
};

export const HubActivityCounts = Schema.Struct({
  "24h": NonNegativeInt,
  "7d": NonNegativeInt,
  "14d": NonNegativeInt,
  "21d": NonNegativeInt,
  "1m": NonNegativeInt,
  "3m": NonNegativeInt,
  "6m": NonNegativeInt,
  "1y": NonNegativeInt,
  all: NonNegativeInt,
});
export type HubActivityCounts = typeof HubActivityCounts.Type;

/** Agent work on this node's T3 project for the checkout, root and worktree threads alike. */
export const HubAgentAttention = Schema.Struct({
  /** Runs (turns) started in the window. */
  runs: HubActivityCounts,
  /** Distinct threads with a run started in the window. */
  threads: HubActivityCounts,
  /** Summed run wall time in whole minutes; a running run counts up to now. */
  minutes: HubActivityCounts,
  lastRunAt: Schema.NullOr(IsoDateTime),
  /** Runs per provider driver (e.g. `claudeAgent`, `codex`), busiest first. */
  providers: Schema.Array(Schema.Struct({ provider: Schema.String, runs: HubActivityCounts })),
});
export type HubAgentAttention = typeof HubAgentAttention.Type;

/** One local calendar day (`YYYY-MM-DD`, node time zone). Days with no activity are omitted. */
export const HubDailyActivity = Schema.Struct({
  day: Schema.String,
  commits: NonNegativeInt,
  runs: NonNegativeInt,
  minutes: NonNegativeInt,
});
export type HubDailyActivity = typeof HubDailyActivity.Type;

/** One project's checkout on the answering node. Projects without a checkout are omitted. */
export const HubProjectInsight = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  platform: HubPlatform,
  /** Commits on HEAD per window. All windows ship together so switching is instant. */
  commits: HubActivityCounts,
  lastCommitAt: Schema.NullOr(IsoDateTime),
  agent: HubAgentAttention,
  /** Sparse, oldest first, covering the last 365 days, for trends and sparklines. */
  daily: Schema.Array(HubDailyActivity),
});
export type HubProjectInsight = typeof HubProjectInsight.Type;

export const HubInsightsInput = Schema.Struct({});
export type HubInsightsInput = typeof HubInsightsInput.Type;

/** Agent work in a T3 workspace on the answering node that no Hub project's checkout matches. */
export const HubUntrackedInsight = Schema.Struct({
  /** The workspace's resolved path on the answering node. */
  workspaceRoot: Schema.String,
  name: Schema.String,
  agent: HubAgentAttention,
  daily: Schema.Array(HubDailyActivity),
});
export type HubUntrackedInsight = typeof HubUntrackedInsight.Type;

export const HubInsights = Schema.Struct({
  nodeName: Schema.String,
  computedAt: IsoDateTime,
  projects: Schema.Array(HubProjectInsight),
  untracked: Schema.Array(HubUntrackedInsight),
});
export type HubInsights = typeof HubInsights.Type;

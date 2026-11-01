/**
 * Codr-Hub: the portfolio and autopilot layer this fork adds on top of T3
 * Code. See docs/codr-hub/ARCHITECTURE.md.
 *
 * Portfolio records are stored as files in a git repo shared by every mesh
 * node, so they are keyed by stable string ids rather than T3 entity ids.
 *
 * @module codrHub
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

export const HubProjectHost = Schema.Struct({ path: TrimmedNonEmptyString });
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

// --- derived helpers shared by server and clients -----------------------------

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

export const DEFAULT_HUB_PACE_TARGETS: HubPaceTargets = {
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

export const HubT3SyncStatus = Schema.Struct({
  enabled: Schema.Boolean,
  lastSyncAt: Schema.NullOr(IsoDateTime),
  lastResult: Schema.NullOr(HubT3SyncResult),
  lastError: Schema.NullOr(Schema.String),
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
 * Union by `project.id`. Overlay path/git/running/pathExists per `snapshot.nodeName`.
 * Shared `HubProject` is one record; if clones disagree, pick latest `updatedAt`
 * (ties keep the first snapshot's record). Later snapshots overwrite the same
 * nodeName. Autopilot eligibility is still this-node: do not treat another
 * host's checkout as making the selected environment eligible.
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

/** Create when `id` is absent, otherwise patch. `localPath` sets this node's checkout. */
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
  notes: Schema.optional(Schema.String),
  localPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
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
]);
export type HubImportInput = typeof HubImportInput.Type;

export const HubImportResult = Schema.Struct({
  imported: NonNegativeInt,
  updated: NonNegativeInt,
  skipped: NonNegativeInt,
  /** T3 projects created from Hub checkouts (Sync with T3 only). */
  created: Schema.optional(NonNegativeInt),
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

// --- dashboard insights ---------------------------------------------------------

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

/** Dashboard activity windows. `ytd` starts on 1 January in the node's local time. */
export const HubActivityWindow = Schema.Literals(["24h", "7d", "30d", "ytd", "all"]);
export type HubActivityWindow = typeof HubActivityWindow.Type;

export const HubActivityCounts = Schema.Struct({
  "24h": NonNegativeInt,
  "7d": NonNegativeInt,
  "30d": NonNegativeInt,
  ytd: NonNegativeInt,
  all: NonNegativeInt,
});
export type HubActivityCounts = typeof HubActivityCounts.Type;

/** One project's checkout on the answering node. Projects without a checkout are omitted. */
export const HubProjectInsight = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  platform: HubPlatform,
  /** Commits on HEAD per window. All windows ship together so switching is instant. */
  commits: HubActivityCounts,
  lastCommitAt: Schema.NullOr(IsoDateTime),
});
export type HubProjectInsight = typeof HubProjectInsight.Type;

export const HubInsightsInput = Schema.Struct({});
export type HubInsightsInput = typeof HubInsightsInput.Type;

export const HubInsights = Schema.Struct({
  nodeName: Schema.String,
  computedAt: IsoDateTime,
  projects: Schema.Array(HubProjectInsight),
});
export type HubInsights = typeof HubInsights.Type;

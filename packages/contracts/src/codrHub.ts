/**
 * Codr-Hub: the portfolio and autopilot layer this fork adds on top of T3
 * Code. See docs/codr-hub/ARCHITECTURE.md.
 *
 * Portfolio records are stored as files in a git repo shared by every mesh
 * node, so they are keyed by stable string ids rather than T3 entity ids.
 *
 * @module codrHub
 */
import * as Schema from "effect/Schema";

import {
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

export const HubSettings = Schema.Struct({
  sdlcMode: HubSdlcMode,
  /** Share of each window the autopilot aims to have used at reset. */
  paceTargetPercent: Schema.Number.check(Schema.isBetween({ minimum: 10, maximum: 100 })),
  maxConcurrentRuns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  /** Redeem a banked reset only when the owner opts in and it would otherwise expire unused. */
  autoDeployBankedResets: Schema.Boolean,
  /** Per-stage prompt overrides; missing stages use the built-in template. */
  stagePrompts: Schema.Record(Schema.String, Schema.String),
});
export type HubSettings = typeof HubSettings.Type;

export const DEFAULT_HUB_SETTINGS: HubSettings = {
  sdlcMode: "three",
  paceTargetPercent: 95,
  maxConcurrentRuns: 2,
  autoDeployBankedResets: false,
  stagePrompts: {},
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
});
export type HubSnapshot = typeof HubSnapshot.Type;

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
});
export type HubUpsertProjectInput = typeof HubUpsertProjectInput.Type;

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
});
export type HubUpdateSettingsInput = typeof HubUpdateSettingsInput.Type;

export const HubSetNodeInput = Schema.Struct({
  nodeName: Schema.optional(TrimmedNonEmptyString),
  autopilotEnabled: Schema.optional(Schema.Boolean),
});
export type HubSetNodeInput = typeof HubSetNodeInput.Type;

export const HubImportInput = Schema.Struct({
  source: Schema.Literal("deez-project-manager"),
  /** Defaults to Deez-PM's app-data file on this machine. */
  path: Schema.optional(TrimmedNonEmptyString),
});
export type HubImportInput = typeof HubImportInput.Type;

export const HubImportResult = Schema.Struct({
  imported: NonNegativeInt,
  updated: NonNegativeInt,
  skipped: NonNegativeInt,
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

export const HubOk = Schema.Struct({ ok: Schema.Literal(true) });
export type HubOk = typeof HubOk.Type;

export class HubError extends Schema.TaggedError<HubError>()("HubError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

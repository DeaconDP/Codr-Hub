/**
 * Which project the autopilot works on next, and how. Pure.
 *
 * @module codrHub/selection
 */
import {
  HUB_AUTONOMY_LABELS,
  HUB_DEFAULT_STAGE_PROMPTS,
  compareHubProjects,
  HUB_STAGE_GROUPS,
  HUB_STAGE_LABELS,
  type HubAutonomy,
  type HubProject,
  type HubProjectView,
  type HubSdlcMode,
  type HubSdlcStage,
  type HubStrategyPriority,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";

/** Why a project is not eligible right now, or null when it is. */
export function ineligibleReason(view: HubProjectView): string | null {
  const { project } = view;
  if (project.archived) return "archived";
  if (project.status !== "active") return `status is ${project.status}`;
  if (project.autonomy === 0) return "autonomy is off";
  if (view.localPath === null) return "no checkout on this node";
  if (!view.pathExists) return "checkout path is missing";
  if (view.running > 0) return "already running";
  if (view.awaitingReview >= project.reviewBudget) return "review budget is full";
  return null;
}

export function pickNextProject(
  views: ReadonlyArray<HubProjectView>,
  strategy: ReadonlyArray<HubStrategyPriority>,
  exclude: ReadonlySet<string> = new Set(),
): HubProjectView | null {
  const compare = compareHubProjects(strategy);
  return (
    views
      .filter((view) => !exclude.has(view.project.id) && ineligibleReason(view) === null)
      .toSorted((a, b) => compare(a.project, b.project))[0] ?? null
  );
}

export interface LaunchSettings {
  readonly interactionMode: ProviderInteractionMode;
  readonly runtimeMode: RuntimeMode;
  readonly worktree: boolean;
}

/** The runtime settings are what enforce an autonomy level; the prompt only explains it. */
export function launchSettingsFor(autonomy: Exclude<HubAutonomy, 0>): LaunchSettings {
  switch (autonomy) {
    case 25:
      return { interactionMode: "plan", runtimeMode: "approval-required", worktree: false };
    case 50:
      return { interactionMode: "default", runtimeMode: "approval-required", worktree: true };
    case 75:
    case 100:
      return { interactionMode: "default", runtimeMode: "full-access", worktree: true };
  }
}

const AUTONOMY_RULES: Record<Exclude<HubAutonomy, 0>, string> = {
  25: "Plan only. Do not edit files; propose a concrete plan for the owner to approve.",
  50: "Work in this worktree. The owner approves each tool call, so keep steps small and explain each one.",
  75: "Work in this worktree, run the relevant tests, commit on this branch, and open a draft pull request. Never merge.",
  100: "Work in this worktree, run the relevant tests, commit, and open a pull request. Merge it into the default branch only if the tests pass and the change is complete.",
};

/** Label for a stage under the current SDLC mode. */
export function stageLabel(stage: HubSdlcStage, mode: HubSdlcMode): string {
  if (mode === "six") return HUB_STAGE_LABELS[stage];
  return HUB_STAGE_GROUPS.find((group) => (group.stages as ReadonlyArray<string>).includes(stage))!
    .label;
}

export function buildAutopilotPrompt(input: {
  readonly project: HubProject;
  readonly mode: HubSdlcMode;
  readonly stagePrompts: Readonly<Record<string, string>>;
  readonly strategyTitle: string | null;
}): string {
  const { project } = input;
  const autonomy = project.autonomy as Exclude<HubAutonomy, 0>;
  const stageInstruction =
    input.stagePrompts[project.stage]?.trim() || HUB_DEFAULT_STAGE_PROMPTS[project.stage];
  return [
    `Codr-Hub autopilot run for "${project.name}".`,
    `SDLC stage: ${stageLabel(project.stage, input.mode)}. Priority: ${project.priority}.${
      input.strategyTitle ? ` Strategy: ${input.strategyTitle}.` : ""
    }`,
    project.notes.trim() ? `Owner notes: ${project.notes.trim()}` : null,
    "",
    stageInstruction,
    "",
    `Autonomy ${autonomy}% (${HUB_AUTONOMY_LABELS[autonomy]}): ${AUTONOMY_RULES[autonomy]}`,
    "Read AGENTS.md/CLAUDE.md, ROADMAP.md, and TODO.md first if they exist. Finish with a short summary of what changed and what the owner should review.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

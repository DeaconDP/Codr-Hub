/**
 * Which model an autopilot launch uses. Defaults live here. Only the three
 * pace targets are stored.
 *
 * @module codrHub/modelPolicy
 */
import {
  DEFAULT_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL,
  ProviderDriverKind,
  type HubJobKind,
  type HubPaceState,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type TestHandoff,
} from "@t3tools/contracts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CURSOR = ProviderDriverKind.make("cursor");
const CODEX = ProviderDriverKind.make("codex");

interface PolicyRow {
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly promptSuffix: string | null;
  readonly coding: boolean;
  readonly effort: boolean;
}

const POLICY: Record<HubJobKind, PolicyRow> = {
  dev: {
    driver: CLAUDE,
    model: "claude-fable-5-1",
    promptSuffix: null,
    coding: true,
    effort: true,
  },
  edit: {
    driver: CURSOR,
    model: "auto",
    promptSuffix: "Follow poteto-mode.",
    coding: true,
    effort: false,
  },
  writing: {
    driver: CODEX,
    model: DEFAULT_TEXT_GENERATION_MODEL,
    promptSuffix: null,
    coding: false,
    effort: false,
  },
  image: {
    driver: CODEX,
    model: DEFAULT_TEXT_GENERATION_MODEL,
    promptSuffix: null,
    coding: false,
    effort: false,
  },
};

/** Codex coding slug. Used only when a coding row's own driver was not selected. */
const CODEX_CODING_MODEL = DEFAULT_MODEL;

export interface LaunchPace {
  readonly state: HubPaceState;
  readonly resetsAt: string | null;
  readonly usedPercent: number | null;
}

export interface LaunchModelProvider {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly models: ReadonlyArray<string>;
  readonly pace: LaunchPace;
}

export type LaunchModelChoice =
  | {
      readonly _tag: "Selected";
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
      readonly options: ReadonlyArray<ProviderOptionSelection>;
      readonly promptSuffix: string | null;
    }
  | { readonly _tag: "NotNow" };

const NOT_NOW: LaunchModelChoice = { _tag: "NotNow" };

function launchWorkKind(jobKind: HubJobKind, handoff: TestHandoff | null): HubJobKind {
  if (handoff?.kind === "fix") return "edit";
  return jobKind;
}

export function selectLaunchModel(input: {
  readonly jobKind: HubJobKind;
  readonly handoff: TestHandoff | null;
  readonly candidate: LaunchModelProvider;
  readonly providers: ReadonlyArray<LaunchModelProvider>;
  readonly codexTargetPercent: number;
}): LaunchModelChoice {
  const row = POLICY[launchWorkKind(input.jobKind, input.handoff)];
  const { candidate } = input;
  if (candidate.driver === row.driver) {
    if (candidate.pace.state === "unavailable" || !candidate.models.includes(row.model)) {
      return NOT_NOW;
    }
    return {
      _tag: "Selected",
      instanceId: candidate.instanceId,
      model: row.model,
      options: row.effort
        ? [{ id: "effort", value: candidate.pace.state === "behind" ? "high" : "medium" }]
        : [],
      promptSuffix: row.promptSuffix,
    };
  }

  const preferredSelected = input.providers.some(
    (provider) =>
      provider.driver === row.driver &&
      provider.pace.state !== "unavailable" &&
      provider.models.includes(row.model),
  );
  if (
    preferredSelected ||
    !row.coding ||
    candidate.driver !== CODEX ||
    candidate.pace.state === "unavailable" ||
    !candidate.models.includes(CODEX_CODING_MODEL) ||
    !codexCodingWindow(candidate, input.providers, input.codexTargetPercent)
  ) {
    return NOT_NOW;
  }
  return {
    _tag: "Selected",
    instanceId: candidate.instanceId,
    model: CODEX_CODING_MODEL,
    options: [],
    promptSuffix: row.promptSuffix,
  };
}

function codexCodingWindow(
  candidate: LaunchModelProvider,
  providers: ReadonlyArray<LaunchModelProvider>,
  targetPercent: number,
): boolean {
  const resetsAt = candidate.pace.resetsAt;
  const used = candidate.pace.usedPercent;
  if (resetsAt === null || used === null || !(used < targetPercent)) return false;
  return providers.every((provider) => {
    if (provider.instanceId === candidate.instanceId) return true;
    if (provider.pace.state === "unavailable" || provider.pace.resetsAt === null) return true;
    return resetsAt < provider.pace.resetsAt;
  });
}

/**
 * What the fleet parent should do with one checkout.
 * The worktree, the child, and the lockfile receipt are the only memory.
 * A crash mid-step leaves those facts, and the next call repeats the same step.
 *
 * @module codrHub/fleetDecide
 */

export type FleetGit =
  | { readonly _tag: "NotACheckout" }
  | { readonly _tag: "NoUpstream" }
  | { readonly _tag: "Dirty" }
  | { readonly _tag: "Ahead"; readonly ahead: number }
  | { readonly _tag: "Diverged" }
  | { readonly _tag: "Behind"; readonly behind: number; readonly upstreamSha: string }
  | { readonly _tag: "Current"; readonly sha: string };

export type FleetTurns = "idle" | "busy" | "silent";

export type FleetChild =
  | { readonly _tag: "Down"; readonly port: "free" }
  | { readonly _tag: "Down"; readonly port: "foreign"; readonly serverPort: number }
  | { readonly _tag: "Owned"; readonly turns: FleetTurns; readonly sha: string };

export type FleetObservation = {
  readonly git: FleetGit;
  readonly child: FleetChild;
  readonly lockInstalled: boolean;
  /** True after a fetch attempt inside the freshness window, including a failed one. */
  readonly fetchedRecently: boolean;
};

export type FleetAction =
  | { readonly _tag: "Stay" }
  | { readonly _tag: "Hold" }
  | { readonly _tag: "Fetch" }
  | { readonly _tag: "FastForward"; readonly sha: string }
  | { readonly _tag: "Install" }
  | { readonly _tag: "Start" }
  | { readonly _tag: "Stop" };

export type FleetPhase = "current" | "waiting" | "updating" | "stuck";

export type FleetDecision = {
  readonly action: FleetAction;
  readonly phase: FleetPhase;
  readonly detail: string;
};

export type FleetShellSignal = {
  readonly activityRunStatus?: string | null | undefined;
  readonly pendingRuntimeRequest?: unknown;
  readonly pendingBackgroundTasks?: readonly unknown[] | null | undefined;
};

/** A live turn, an approval wait, or background work the autopilot ledger does not list. */
export const fleetShellBusy = (shells: readonly FleetShellSignal[]): boolean =>
  shells.some(
    (shell) =>
      (shell.activityRunStatus != null && shell.activityRunStatus !== "") ||
      shell.pendingRuntimeRequest != null ||
      (shell.pendingBackgroundTasks?.length ?? 0) > 0,
  );

/** Local git facts only. Fetch success is not part of this classification. */
export const classifyGitStatus = (input: {
  readonly isRepo: boolean;
  readonly porcelain: string;
  readonly headSha: string | null;
  readonly upstreamSha: string | null;
  readonly ahead: number;
  readonly behind: number;
}): FleetGit => {
  if (!input.isRepo || input.headSha === null) return { _tag: "NotACheckout" };
  if (input.porcelain.trim() !== "") return { _tag: "Dirty" };
  if (input.upstreamSha === null) return { _tag: "NoUpstream" };
  if (input.ahead > 0 && input.behind > 0) return { _tag: "Diverged" };
  if (input.ahead > 0) return { _tag: "Ahead", ahead: input.ahead };
  if (input.behind > 0) {
    return { _tag: "Behind", behind: input.behind, upstreamSha: input.upstreamSha };
  }
  return { _tag: "Current", sha: input.headSha };
};

const stuckDetail = (git: FleetGit): string => {
  switch (git._tag) {
    case "NotACheckout":
      return "This folder is not a git checkout. It was left alone.";
    case "NoUpstream":
      return "This checkout has no upstream. It was left alone.";
    case "Dirty":
      return "This checkout has uncommitted work. It was left alone.";
    case "Ahead":
      return `This checkout is ${git.ahead} commit${git.ahead === 1 ? "" : "s"} ahead of upstream. It was left alone.`;
    case "Diverged":
      return "This checkout has diverged from upstream. It was left alone.";
    default:
      return "This checkout was left alone.";
  }
};

const hold = (detail: string, phase: FleetPhase): FleetDecision => ({
  action: { _tag: "Hold" },
  phase,
  detail,
});

/**
 * One action. Fetch does not move HEAD. Fast-forward, install, and start
 * run only when the child is already down. A busy or silent child is stopped
 * only by a later tick, after the turn report says idle.
 */
export const decide = (observation: FleetObservation): FleetDecision => {
  const { git, child } = observation;

  if (child._tag === "Down" && child.port === "foreign") {
    return {
      action: { _tag: "Stay" },
      phase: "stuck",
      detail: `Another server uses this data directory on port ${child.serverPort}. Stop it before starting the fleet parent. This checkout was left alone.`,
    };
  }

  if (
    git._tag === "NotACheckout" ||
    git._tag === "NoUpstream" ||
    git._tag === "Dirty" ||
    git._tag === "Ahead" ||
    git._tag === "Diverged"
  ) {
    const detail = stuckDetail(git);
    if (!observation.fetchedRecently && git._tag !== "NotACheckout") {
      return { action: { _tag: "Fetch" }, phase: "stuck", detail };
    }
    if (child._tag === "Down") {
      return { action: { _tag: "Start" }, phase: "stuck", detail };
    }
    return { action: { _tag: "Stay" }, phase: "stuck", detail };
  }

  if (!observation.fetchedRecently) {
    return {
      action: { _tag: "Fetch" },
      phase: git._tag === "Behind" ? "waiting" : "current",
      detail: "Checking for updates.",
    };
  }

  if (child._tag === "Owned" && (child.turns === "busy" || child.turns === "silent")) {
    if (child.turns === "silent") {
      return hold(
        "The server stopped reporting turns. It stays up until that report returns or the process exits.",
        "waiting",
      );
    }
    if (git._tag === "Behind") {
      return hold("An update is waiting until the agent turn finishes.", "waiting");
    }
    if (!observation.lockInstalled) {
      return hold("Dependencies changed. Waiting until the agent turn finishes.", "waiting");
    }
    return { action: { _tag: "Stay" }, phase: "current", detail: "Up to date." };
  }

  if (git._tag === "Behind") {
    if (child._tag === "Owned") {
      return {
        action: { _tag: "Stop" },
        phase: "updating",
        detail: "Stopping the server to fast-forward.",
      };
    }
    return {
      action: { _tag: "FastForward", sha: git.upstreamSha },
      phase: "updating",
      detail: "Fast-forwarding to the fleet branch.",
    };
  }

  if (!observation.lockInstalled) {
    if (child._tag === "Owned") {
      return {
        action: { _tag: "Stop" },
        phase: "updating",
        detail: "Stopping the server to install dependencies.",
      };
    }
    return { action: { _tag: "Install" }, phase: "updating", detail: "Installing dependencies." };
  }

  if (child._tag === "Down") {
    return { action: { _tag: "Start" }, phase: "current", detail: "Up to date." };
  }

  if (child.sha !== git.sha) {
    return {
      action: { _tag: "Stop" },
      phase: "updating",
      detail: "Restarting onto the current commit.",
    };
  }

  return { action: { _tag: "Stay" }, phase: "current", detail: "Up to date." };
};

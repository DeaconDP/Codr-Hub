/**
 * Quota pacing for the Codr-Hub autopilot. Pure: the service feeds it the
 * provider snapshots T3 already publishes and acts on the result.
 *
 * The longest window (usually weekly) is the budget being paced, because it
 * is the quota that is lost at reset. Shorter windows (the five-hour session)
 * only cap: once any window reaches the target, the provider waits for that
 * window to reset.
 *
 * @module codrHub/pacing
 */
import type { HubPace, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

export interface PaceWindowInput {
  readonly label: string;
  readonly kind: "session" | "weekly" | "monthly" | "other";
  readonly usedPercent: number;
  readonly resetsAt?: string | undefined;
  readonly windowDurationMins?: number | undefined;
}

export interface PaceProviderInput {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly label: string;
  /** Enabled, installed, signed in, and not in an error state. */
  readonly usable: boolean;
  readonly windows: ReadonlyArray<PaceWindowInput>;
  readonly bankedResets: number;
  readonly bankedResetExpiresAt: string | null;
  /** Autopilot threads currently running on this instance. */
  readonly running: number;
}

export interface PaceOptions {
  readonly targetPercent: number;
  readonly maxConcurrentRuns: number;
  readonly autoDeployBankedResets: boolean;
  readonly nowMs: number;
}

export interface PaceDecision {
  readonly pace: HubPace;
  /** Redeem one banked reset now: capped, opted in, and the credit would expire before the cap lifts. */
  readonly deployBankedReset: boolean;
}

const FALLBACK_DURATION_MINS: Record<PaceWindowInput["kind"], number | null> = {
  session: 5 * 60,
  weekly: 7 * 24 * 60,
  monthly: 30 * 24 * 60,
  other: null,
};

/** Points behind target at which the push is at full strength. */
const FULL_URGENCY_DEFICIT = 10;
/** Exponent of the target curve; above 1 holds back early and pushes late. */
const CURVE = 1.5;

interface TimedWindow {
  readonly window: PaceWindowInput;
  readonly resetsAtMs: number;
  readonly durationMs: number;
}

const timed = (window: PaceWindowInput): TimedWindow | null => {
  if (!window.resetsAt) return null;
  const resetsAtMs = Date.parse(window.resetsAt);
  const mins = window.windowDurationMins ?? FALLBACK_DURATION_MINS[window.kind];
  if (!Number.isFinite(resetsAtMs) || !mins) return null;
  return { window, resetsAtMs, durationMs: mins * 60_000 };
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Share of the target that should be used by now, given elapsed fraction `elapsed`. */
export const targetAt = (elapsed: number, targetPercent: number) =>
  targetPercent * clamp01(elapsed) ** CURVE;

export function computePace(provider: PaceProviderInput, options: PaceOptions): PaceDecision {
  const base = {
    instanceId: provider.instanceId,
    driver: provider.driver,
    label: provider.label,
    running: provider.running,
    bankedResets: provider.bankedResets,
    bankedResetExpiresAt: provider.bankedResetExpiresAt,
  };
  const idle = (
    state: HubPace["state"],
    reason: string,
    extra: Partial<HubPace> = {},
  ): PaceDecision => ({
    pace: {
      ...base,
      state,
      windowLabel: null,
      usedPercent: null,
      targetPercent: null,
      resetsAt: null,
      desiredConcurrency: 0,
      reason,
      ...extra,
    },
    deployBankedReset: false,
  });

  if (!provider.usable) return idle("unavailable", "Provider is not ready or not signed in.");
  const windows = provider.windows.flatMap((window) => {
    const t = timed(window);
    return t ? [t] : [];
  });
  if (windows.length === 0) {
    // API-key and pay-per-use accounts report no windows; the autopilot only
    // spends subscription quota.
    return idle("unavailable", "No subscription windows reported.");
  }

  const capping = windows
    .filter((w) => w.window.usedPercent >= options.targetPercent && w.resetsAtMs > options.nowMs)
    .toSorted((a, b) => b.resetsAtMs - a.resetsAtMs)[0];
  if (capping) {
    const expiresMs = provider.bankedResetExpiresAt
      ? Date.parse(provider.bankedResetExpiresAt)
      : Number.POSITIVE_INFINITY;
    const deploy =
      options.autoDeployBankedResets && provider.bankedResets > 0 && expiresMs < capping.resetsAtMs;
    const bankedNote =
      provider.bankedResets > 0
        ? ` ${provider.bankedResets} banked reset${provider.bankedResets === 1 ? "" : "s"} available.`
        : "";
    return {
      ...idle("capped", `${capping.window.label} reached ${options.targetPercent}%.${bankedNote}`, {
        windowLabel: capping.window.label,
        usedPercent: capping.window.usedPercent,
        targetPercent: options.targetPercent,
        resetsAt: isoAt(capping.resetsAtMs),
      }),
      deployBankedReset: deploy,
    };
  }

  const budget = windows.toSorted((a, b) => b.durationMs - a.durationMs)[0]!;
  // A banked reset that expires before the window resets is quota that is
  // lost unless the current window is spent by then, so pace to its expiry.
  const expiresMs = provider.bankedResetExpiresAt
    ? Date.parse(provider.bankedResetExpiresAt)
    : Number.NaN;
  const deadlineMs =
    provider.bankedResets > 0 && expiresMs > options.nowMs && expiresMs < budget.resetsAtMs
      ? expiresMs
      : budget.resetsAtMs;
  const elapsed = clamp01(1 - (deadlineMs - options.nowMs) / budget.durationMs);
  const target = targetAt(elapsed, options.targetPercent);
  const used = budget.window.usedPercent;
  const deficit = target - used;
  const shown = {
    windowLabel: budget.window.label,
    usedPercent: used,
    targetPercent: Math.round(target * 10) / 10,
    resetsAt: isoAt(budget.resetsAtMs),
  };
  if (deficit <= 0) {
    return idle("on_pace", `${budget.window.label} is on pace.`, shown);
  }
  // Urgency grows with how far behind we are; the late-window boost makes
  // the same deficit push harder as the reset approaches.
  const urgency = clamp01(deficit / FULL_URGENCY_DEFICIT) * (0.5 + elapsed);
  const desiredConcurrency = Math.max(
    1,
    Math.min(options.maxConcurrentRuns, Math.ceil(options.maxConcurrentRuns * clamp01(urgency))),
  );
  return {
    pace: {
      ...base,
      ...shown,
      state: "behind",
      desiredConcurrency,
      reason: `${Math.round(deficit)} points behind target on ${budget.window.label}.`,
    },
    deployBankedReset: false,
  };
}

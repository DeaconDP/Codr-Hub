import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { computePace, targetAt, type PaceProviderInput, type PaceWindowInput } from "./pacing.ts";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const weekly = (usedPercent: number, hoursToReset: number): PaceWindowInput => ({
  label: "Weekly",
  kind: "weekly",
  usedPercent,
  resetsAt: iso(NOW + hoursToReset * HOUR),
  windowDurationMins: 7 * 24 * 60,
});
const session = (usedPercent: number, hoursToReset: number): PaceWindowInput => ({
  label: "Session",
  kind: "session",
  usedPercent,
  resetsAt: iso(NOW + hoursToReset * HOUR),
  windowDurationMins: 5 * 60,
});

const provider = (overrides: Partial<PaceProviderInput>): PaceProviderInput => ({
  instanceId: ProviderInstanceId.make("claude"),
  driver: ProviderDriverKind.make("claudeAgent"),
  label: "Claude",
  usable: true,
  windows: [],
  bankedResets: 0,
  bankedResetExpiresAt: null,
  running: 0,
  ...overrides,
});

const options = {
  targetPercent: 95,
  maxConcurrentRuns: 4,
  autoDeployBankedResets: false,
  nowMs: NOW,
};

describe("codr-hub pacing", () => {
  it("aims at the target by the reset, holding back early", () => {
    expect(targetAt(0, 95)).toBe(0);
    expect(targetAt(1, 95)).toBe(95);
    expect(targetAt(0.5, 95)).toBeLessThan(95 / 2);
  });

  it("never paces API-key accounts that report no windows", () => {
    expect(computePace(provider({}), options).pace.state).toBe("unavailable");
    expect(
      computePace(provider({ usable: false, windows: [weekly(0, 24)] }), options).pace.state,
    ).toBe("unavailable");
  });

  it("is on pace when usage is ahead of the curve", () => {
    // Halfway through the week the curve asks for ~33.6%.
    const decision = computePace(provider({ windows: [weekly(40, 84)] }), options);
    expect(decision.pace.state).toBe("on_pace");
    expect(decision.pace.desiredConcurrency).toBe(0);
  });

  it("pushes harder for the same deficit as the reset approaches", () => {
    // Both are about 4.5 points behind their curve.
    const early = computePace(provider({ windows: [weekly(10, 120)] }), options).pace;
    const late = computePace(provider({ windows: [weekly(85.4, 6)] }), options).pace;
    expect(early.state).toBe("behind");
    expect(late.state).toBe("behind");
    expect(late.desiredConcurrency).toBeGreaterThan(early.desiredConcurrency);
    const farBehind = computePace(provider({ windows: [weekly(40, 6)] }), options).pace;
    expect(farBehind.desiredConcurrency).toBe(options.maxConcurrentRuns);
  });

  it("paces the longest window and lets shorter windows only cap", () => {
    const behind = computePace(provider({ windows: [session(50, 2), weekly(10, 12)] }), options);
    expect(behind.pace.windowLabel).toBe("Weekly");
    expect(behind.pace.state).toBe("behind");

    const capped = computePace(provider({ windows: [session(96, 2), weekly(10, 12)] }), options);
    expect(capped.pace.state).toBe("capped");
    expect(capped.pace.windowLabel).toBe("Session");
    expect(capped.pace.desiredConcurrency).toBe(0);
  });

  it("deploys a banked reset only when opted in and the credit would expire before the cap lifts", () => {
    const cappedWeek = { windows: [weekly(97, 48)], bankedResets: 2 };
    const expiresSoon = { ...cappedWeek, bankedResetExpiresAt: iso(NOW + 24 * HOUR) };
    const expiresLate = { ...cappedWeek, bankedResetExpiresAt: iso(NOW + 72 * HOUR) };

    expect(computePace(provider(expiresSoon), options).deployBankedReset).toBe(false);
    const optedIn = { ...options, autoDeployBankedResets: true };
    expect(computePace(provider(expiresSoon), optedIn).deployBankedReset).toBe(true);
    expect(computePace(provider(expiresLate), optedIn).deployBankedReset).toBe(false);
    expect(computePace(provider(expiresSoon), optedIn).pace.reason).toContain("2 banked resets");
  });

  it("paces to a banked reset's expiry when it lands before the window reset", () => {
    const plain = computePace(provider({ windows: [weekly(30, 96)] }), options).pace;
    const withCredit = computePace(
      provider({
        windows: [weekly(30, 96)],
        bankedResets: 1,
        bankedResetExpiresAt: iso(NOW + 12 * HOUR),
      }),
      options,
    ).pace;
    expect(plain.state).toBe("on_pace");
    expect(withCredit.state).toBe("behind");
  });
});

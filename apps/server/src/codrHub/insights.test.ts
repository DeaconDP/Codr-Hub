import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { activitySinceMs, bucketCommits, detectPlatform, yearStartMs } from "./insights.ts";

describe("codr-hub insights platform", () => {
  it("lets an engine checkout beat a rough Web tag", () => {
    expect(detectPlatform(["Web"], ["Game.uproject", "Content", "Source"])).toBe("unreal");
    expect(detectPlatform(["web"], ["Assets", "ProjectSettings", "Packages"])).toBe("unity");
  });

  it("trusts an engine tag over the files", () => {
    expect(detectPlatform(["UE5"], ["package.json"])).toBe("unreal");
    expect(detectPlatform(["Android"], ["ios", "android", "package.json"])).toBe("android");
  });

  it("uses a generic tag over generic files", () => {
    expect(detectPlatform(["Desktop"], ["package.json", "index.html"])).toBe("desktop");
  });

  it("reads the checkout when no tag matches", () => {
    expect(detectPlatform(["Client work"], ["ios", "android", "package.json"])).toBe("ios");
    expect(detectPlatform([], ["package.json", "src-tauri"])).toBe("desktop");
    expect(detectPlatform([], ["Cargo.toml", "src"])).toBe("rust");
    expect(detectPlatform([], ["build.gradle.kts", "app"])).toBe("android");
    expect(detectPlatform([], ["pyproject.toml"])).toBe("python");
    expect(detectPlatform([], ["README.md"])).toBe("other");
  });
});

const localMs = (year: number, month: number, day: number, hour = 0) =>
  DateTime.toEpochMillis(
    DateTime.makeZonedUnsafe(
      { year, month, day, hour },
      { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
    ),
  );

describe("codr-hub insights activity", () => {
  const now = localMs(2026, 10, 31, 12);
  const secondsAgo = (days: number) => Math.floor((now - days * 86_400_000) / 1000);

  it("counts each commit into every window it falls in", () => {
    const ytd = yearStartMs(now);
    const timestamps = [secondsAgo(0.5), secondsAgo(3), secondsAgo(20), secondsAgo(200)];
    expect(bucketCommits(timestamps, 57, now, ytd)).toEqual({
      "24h": 1,
      "7d": 2,
      "30d": 3,
      ytd: 4,
      all: 57,
    });
  });

  it("starts the year at local midnight on 1 January", () => {
    expect(yearStartMs(now)).toBe(localMs(2026, 1, 1));
  });

  it("reaches back far enough for whichever of 30 days and the year is older", () => {
    const earlyJanuary = localMs(2026, 1, 5);
    expect(activitySinceMs(earlyJanuary)).toBe(earlyJanuary - 30 * 86_400_000);
    expect(activitySinceMs(now)).toBe(yearStartMs(now));
  });
});

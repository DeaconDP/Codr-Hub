/**
 * Pure helpers for the Hub dashboard: what a checkout is built with, and how
 * many commits landed in each activity window.
 *
 * @module codrHub/insights
 */
import type { HubActivityCounts, HubPlatform } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Platforms whose files are unambiguous. These beat a generic tag like "Web". */
const STRONG: ReadonlySet<HubPlatform> = new Set(["unreal", "unity", "ios", "android"]);

const TAG_PLATFORMS: Readonly<Record<string, HubPlatform>> = {
  unreal: "unreal",
  "unreal engine": "unreal",
  ue4: "unreal",
  ue5: "unreal",
  unity: "unity",
  ios: "ios",
  swift: "ios",
  apple: "ios",
  iphone: "ios",
  mobile: "ios",
  expo: "ios",
  "react native": "ios",
  android: "android",
  kotlin: "android",
  web: "web",
  website: "web",
  webapp: "web",
  "web app": "web",
  desktop: "desktop",
  electron: "desktop",
  tauri: "desktop",
  windows: "desktop",
  macos: "desktop",
  python: "python",
  rust: "rust",
};

function platformFromTags(tags: ReadonlyArray<string>) {
  let strong: HubPlatform | null = null;
  let weak: HubPlatform | null = null;
  for (const tag of tags) {
    const platform = TAG_PLATFORMS[tag.trim().toLowerCase()];
    if (platform === undefined) continue;
    if (STRONG.has(platform)) strong ??= platform;
    else weak ??= platform;
  }
  return { strong, weak };
}

function platformFromEntries(entries: ReadonlyArray<string>): HubPlatform | null {
  const names = new Set(entries);
  const any = (test: (name: string) => boolean) => entries.some(test);
  if (any((name) => name.endsWith(".uproject"))) return "unreal";
  if (names.has("ProjectSettings") && names.has("Assets")) return "unity";
  // Expo / React Native lands here too (ios dir, or eas.json before prebuild).
  if (
    any((name) => name.endsWith(".xcodeproj") || name.endsWith(".xcworkspace")) ||
    names.has("Package.swift") ||
    names.has("ios") ||
    names.has("eas.json")
  )
    return "ios";
  if (
    names.has("build.gradle") ||
    names.has("build.gradle.kts") ||
    names.has("settings.gradle") ||
    names.has("settings.gradle.kts") ||
    names.has("android")
  )
    return "android";
  if (
    names.has("src-tauri") ||
    any((name) => name.startsWith("electron-builder")) ||
    any((name) => name.endsWith(".sln") || name.endsWith(".csproj"))
  )
    return "desktop";
  if (names.has("Cargo.toml")) return "rust";
  if (names.has("package.json") || names.has("index.html")) return "web";
  if (names.has("pyproject.toml") || names.has("requirements.txt") || names.has("setup.py"))
    return "python";
  return null;
}

/**
 * Picks a checkout's platform from its tags and root directory entry names.
 * Precedence: an engine/native tag (Unreal, Unity, iOS, Android), then an
 * engine/native file signal, then any other tag, then any other file signal,
 * then "other". Tags are rough imports, so a `.uproject` beats a "Web" tag.
 */
export function detectPlatform(
  tags: ReadonlyArray<string>,
  rootEntries: ReadonlyArray<string>,
): HubPlatform {
  const fromTags = platformFromTags(tags);
  const fromFiles = platformFromEntries(rootEntries);
  if (fromTags.strong !== null) return fromTags.strong;
  if (fromFiles !== null && STRONG.has(fromFiles)) return fromFiles;
  return fromTags.weak ?? fromFiles ?? "other";
}

/** 1 January, 00:00 in the node's local time zone. */
export function yearStartMs(nowMs: number): number {
  const local = DateTime.makeZonedUnsafe(nowMs, { timeZone: DateTime.zoneMakeLocal() });
  return DateTime.toEpochMillis(DateTime.startOf(local, "year"));
}

export const isoFromMs = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** The oldest commit time any bucketed window needs, for `git log --since`. */
export function activitySinceMs(nowMs: number): number {
  return Math.min(nowMs - 30 * DAY_MS, yearStartMs(nowMs));
}

/** Parses `git log --format=%ct` output into Unix seconds. */
export function parseCommitTimestamps(stdout: string): number[] {
  return stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
}

/**
 * Counts commits per window. `timestampsSeconds` must cover at least
 * `activitySinceMs(nowMs)`; `totalCount` is all of HEAD's history.
 */
export function bucketCommits(
  timestampsSeconds: ReadonlyArray<number>,
  totalCount: number,
  nowMs: number,
  ytdStartMs: number,
): HubActivityCounts {
  const counts = { "24h": 0, "7d": 0, "30d": 0, ytd: 0, all: 0 };
  for (const seconds of timestampsSeconds) {
    const at = seconds * 1000;
    if (at >= nowMs - DAY_MS) counts["24h"] += 1;
    if (at >= nowMs - 7 * DAY_MS) counts["7d"] += 1;
    if (at >= nowMs - 30 * DAY_MS) counts["30d"] += 1;
    if (at >= ytdStartMs) counts.ytd += 1;
  }
  counts.all = Math.max(totalCount, counts["30d"], counts.ytd);
  return counts;
}

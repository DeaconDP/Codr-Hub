import {
  DEFAULT_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type TestHandoff,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { selectLaunchModel, type LaunchModelProvider, type LaunchPace } from "./modelPolicy.ts";

const pace = (overrides: Partial<LaunchPace> = {}): LaunchPace => ({
  state: "on_pace",
  resetsAt: "2026-10-20T00:00:00.000Z",
  usedPercent: 40,
  ...overrides,
});

const provider = (overrides: Partial<LaunchModelProvider> = {}): LaunchModelProvider => ({
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  models: ["claude-fable-5-1"],
  pace: pace(),
  ...overrides,
});

const fixHandoff: TestHandoff = {
  version: 1,
  kind: "fix",
  projectId: "alpha",
  updatedAt: "2026-10-20T13:00:00.000Z",
  sourceThreadId: ThreadId.make("thread-a"),
  sourceStage: "develop",
  nodeName: "Steve",
  finishedAt: "2026-10-20T12:00:00.000Z",
  note: "Tighten the empty state",
  notedAt: "2026-10-20T13:00:00.000Z",
};

const claude = provider();
const cursor = provider({
  instanceId: ProviderInstanceId.make("cursor"),
  driver: ProviderDriverKind.make("cursor"),
  models: ["auto"],
  pace: pace({ resetsAt: "2026-10-21T00:00:00.000Z" }),
});
const codex = provider({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  models: [DEFAULT_MODEL, DEFAULT_TEXT_GENERATION_MODEL],
  pace: pace({ resetsAt: "2026-10-18T00:00:00.000Z", usedPercent: 79 }),
});

describe("launch model policy", () => {
  it("uses medium effort for dev, and high when that provider is behind", () => {
    expect(
      selectLaunchModel({
        jobKind: "dev",
        handoff: null,
        candidate: claude,
        providers: [claude],
        codexTargetPercent: 80,
      }),
    ).toEqual({
      _tag: "Selected",
      instanceId: claude.instanceId,
      model: "claude-fable-5-1",
      options: [{ id: "effort", value: "medium" }],
      promptSuffix: null,
    });
    expect(
      selectLaunchModel({
        jobKind: "dev",
        handoff: null,
        candidate: provider({ pace: pace({ state: "behind" }) }),
        providers: [claude],
        codexTargetPercent: 80,
      }),
    ).toMatchObject({ options: [{ id: "effort", value: "high" }] });
  });

  it("forces edit and the poteto suffix when the handoff is a fix", () => {
    expect(
      selectLaunchModel({
        jobKind: "writing",
        handoff: fixHandoff,
        candidate: cursor,
        providers: [claude, cursor, codex],
        codexTargetPercent: 80,
      }),
    ).toEqual({
      _tag: "Selected",
      instanceId: cursor.instanceId,
      model: "auto",
      options: [],
      promptSuffix: "Follow poteto-mode.",
    });
  });

  it("refuses codex coding at the target, and allows it when codex resets sooner and is under it", () => {
    const claudeMissing = provider({ models: ["claude-haiku-4-5"] });
    const atTarget = provider({
      ...codex,
      pace: pace({ resetsAt: "2026-10-18T00:00:00.000Z", usedPercent: 80 }),
    });
    expect(
      selectLaunchModel({
        jobKind: "dev",
        handoff: null,
        candidate: atTarget,
        providers: [claudeMissing, atTarget],
        codexTargetPercent: 80,
      }),
    ).toEqual({ _tag: "NotNow" });

    expect(
      selectLaunchModel({
        jobKind: "dev",
        handoff: null,
        candidate: codex,
        providers: [claudeMissing, codex],
        codexTargetPercent: 80,
      }),
    ).toEqual({
      _tag: "Selected",
      instanceId: codex.instanceId,
      model: DEFAULT_MODEL,
      options: [],
      promptSuffix: null,
    });
  });

  it("does not fall through when the preferred slug is absent", () => {
    const claudeMissing = provider({ models: ["claude-haiku-4-5"] });
    expect(
      selectLaunchModel({
        jobKind: "dev",
        handoff: null,
        candidate: claudeMissing,
        providers: [claudeMissing],
        codexTargetPercent: 80,
      }),
    ).toEqual({ _tag: "NotNow" });
  });

  it("uses gpt-6-luna for writing without the coding exception", () => {
    const writingCodex = provider({
      ...codex,
      models: [DEFAULT_TEXT_GENERATION_MODEL],
      pace: pace({ resetsAt: "2026-10-28T00:00:00.000Z", usedPercent: 80 }),
    });
    expect(
      selectLaunchModel({
        jobKind: "writing",
        handoff: null,
        candidate: writingCodex,
        providers: [claude, writingCodex],
        codexTargetPercent: 80,
      }),
    ).toEqual({
      _tag: "Selected",
      instanceId: writingCodex.instanceId,
      model: DEFAULT_TEXT_GENERATION_MODEL,
      options: [],
      promptSuffix: null,
    });
  });
});

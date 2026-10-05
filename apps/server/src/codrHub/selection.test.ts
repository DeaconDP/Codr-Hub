import type { HubProject, HubProjectView } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  buildAutopilotPrompt,
  ineligibleReason,
  launchSettingsFor,
  pickNextProject,
  stageLabel,
} from "./selection.ts";

const project = (overrides: Partial<HubProject>): HubProject => ({
  id: "p",
  name: "P",
  priority: "medium",
  status: "active",
  stage: "develop",
  strategyId: null,
  category: null,
  tags: [],
  repoUrl: null,
  notes: "",
  hosts: { Steve: { path: "/work/p" } },
  autonomy: 75,
  reviewBudget: 2,
  sortIndex: 0,
  favorite: false,
  archived: false,
  createdAt: "2026-10-05T00:00:00.000Z",
  updatedAt: "2026-10-05T00:00:00.000Z",
  ...overrides,
});

const view = (
  overrides: Partial<HubProject>,
  state: Partial<HubProjectView> = {},
): HubProjectView => ({
  project: project(overrides),
  localPath: "/work/p",
  pathExists: true,
  git: null,
  awaitingReview: 0,
  running: 0,
  lastLaunchAt: null,
  ...state,
});

const strategy = [
  { id: "ship-emily", title: "Ship Emily-OS v1", notes: "" },
  { id: "publicity", title: "Publicity", notes: "" },
];

describe("codr-hub selection", () => {
  it("ranks by strategy order before priority", () => {
    const picked = pickNextProject(
      [
        view({ id: "critical-unlinked", name: "A", priority: "critical" }),
        view({ id: "low-publicity", name: "B", priority: "low", strategyId: "publicity" }),
        view({ id: "low-emily", name: "C", priority: "low", strategyId: "ship-emily" }),
      ],
      strategy,
    );
    expect(picked?.project.id).toBe("low-emily");
  });

  it("falls back to priority, favourites, then manual order", () => {
    const picked = pickNextProject(
      [
        view({ id: "med", name: "A", priority: "medium", sortIndex: 0 }),
        view({ id: "high-later", name: "B", priority: "high", sortIndex: 5 }),
        view({ id: "high-fav", name: "C", priority: "high", sortIndex: 9, favorite: true }),
      ],
      [],
    );
    expect(picked?.project.id).toBe("high-fav");
  });

  it("skips projects that are not eligible on this node", () => {
    expect(ineligibleReason(view({ autonomy: 0 }))).toBe("autonomy is off");
    expect(ineligibleReason(view({ status: "paused" }))).toBe("status is paused");
    expect(ineligibleReason(view({ archived: true }))).toBe("archived");
    expect(ineligibleReason(view({}, { localPath: null }))).toBe("no checkout on this node");
    expect(ineligibleReason(view({}, { pathExists: false }))).toBe("checkout path is missing");
    expect(ineligibleReason(view({}, { running: 1 }))).toBe("already running");
    expect(ineligibleReason(view({ reviewBudget: 2 }, { awaitingReview: 2 }))).toBe(
      "review budget is full",
    );
    expect(ineligibleReason(view({}))).toBeNull();
  });

  it("honours an exclusion set so one tick never launches a project twice", () => {
    const views = [view({ id: "a", name: "A", priority: "high" }), view({ id: "b", name: "B" })];
    expect(pickNextProject(views, [], new Set(["a"]))?.project.id).toBe("b");
  });

  it("enforces autonomy through runtime settings, not just the prompt", () => {
    expect(launchSettingsFor(25)).toEqual({
      interactionMode: "plan",
      runtimeMode: "approval-required",
      worktree: false,
    });
    expect(launchSettingsFor(50).runtimeMode).toBe("approval-required");
    expect(launchSettingsFor(75)).toEqual({
      interactionMode: "default",
      runtimeMode: "full-access",
      worktree: true,
    });
  });

  it("labels stages for both SDLC modes", () => {
    expect(stageLabel("test", "three")).toBe("Dev & Test");
    expect(stageLabel("test", "six")).toBe("Test");
  });

  it("builds a stage prompt with owner overrides and autonomy limits", () => {
    const prompt = buildAutopilotPrompt({
      project: project({ name: "Emily-OS", stage: "plan", autonomy: 75, notes: "Focus on iOS." }),
      mode: "three",
      stagePrompts: { plan: "Write the v1 spec." },
      strategyTitle: "Ship Emily-OS v1",
    });
    expect(prompt).toContain('"Emily-OS"');
    expect(prompt).toContain("Plan & Design");
    expect(prompt).toContain("Strategy: Ship Emily-OS v1.");
    expect(prompt).toContain("Write the v1 spec.");
    expect(prompt).toContain("Focus on iOS.");
    expect(prompt).toContain("Never merge.");
  });
});

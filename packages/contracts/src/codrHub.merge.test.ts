import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_HUB_SETTINGS,
  HubProject as HubProjectSchema,
  HubProjectView as HubProjectViewSchema,
  hubProjectViewForNode,
  mergeHubProjectViews,
  mergedProjectLastLaunchAt,
  type HubProject,
  type HubProjectView,
  type HubSnapshot,
  type TestHandoff,
} from "./codrHub.ts";

const project = (overrides: Partial<HubProject>): HubProject => ({
  id: "alpha",
  name: "Alpha",
  priority: "medium",
  status: "active",
  stage: "develop",
  strategyId: null,
  category: null,
  tags: [],
  repoUrl: null,
  notes: "",
  hosts: {},
  autonomy: 0,
  reviewBudget: 2,
  sortIndex: 0,
  favorite: false,
  archived: false,
  lane: null,
  jobKind: "dev",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const view = (overrides: Partial<HubProjectView> & { project: HubProject }): HubProjectView => ({
  localPath: null,
  pathExists: false,
  git: null,
  awaitingReview: 0,
  running: 0,
  lastLaunchAt: null,
  handoff: null,
  ...overrides,
});

const snapshot = (overrides: Pick<HubSnapshot, "nodeName" | "projects">): HubSnapshot => ({
  autopilotEnabled: false,
  autopilotNote: null,
  settings: DEFAULT_HUB_SETTINGS,
  strategy: [],
  pace: [],
  recentLaunches: [],
  sync: {
    portfolioPath: "/tmp/portfolio",
    remote: null,
    lastSyncAt: null,
    lastError: null,
  },
  deezProjectManagerPath: null,
  ...overrides,
});

describe("mergeHubProjectViews", () => {
  it("unions by project id and overlays per nodeName", () => {
    const steveProject = project({
      hosts: { Steve: { path: "/Users/steve/Alpha" } },
      updatedAt: "2026-10-02T00:00:00.000Z",
    });
    const adaProject = project({
      name: "Alpha from Ada",
      hosts: { Ada: { path: "/Users/ada/Alpha" } },
      updatedAt: "2026-10-03T00:00:00.000Z",
    });
    expect(
      mergeHubProjectViews([
        snapshot({
          nodeName: "Steve",
          projects: [
            view({
              project: steveProject,
              localPath: "/Users/steve/Alpha",
              pathExists: true,
              git: {
                branch: "main",
                dirty: false,
                ahead: 0,
                behind: 0,
                hasUpstream: true,
              },
              awaitingReview: 1,
              running: 0,
              lastLaunchAt: "2026-10-02T12:00:00.000Z",
            }),
          ],
        }),
        snapshot({
          nodeName: "Ada",
          projects: [
            view({
              project: adaProject,
              localPath: "/Users/ada/Alpha",
              pathExists: true,
              git: {
                branch: "feat",
                dirty: true,
                ahead: 1,
                behind: 0,
                hasUpstream: true,
              },
              awaitingReview: 0,
              running: 1,
              lastLaunchAt: "2026-10-04T00:00:00.000Z",
            }),
            view({
              project: project({
                id: "beta",
                name: "Beta",
                updatedAt: "2026-10-01T00:00:00.000Z",
              }),
              localPath: null,
            }),
          ],
        }),
      ]),
    ).toEqual([
      {
        project: adaProject,
        handoff: null,
        nodes: [
          {
            nodeName: "Steve",
            localPath: "/Users/steve/Alpha",
            pathExists: true,
            git: { branch: "main", dirty: false, ahead: 0, behind: 0, hasUpstream: true },
            awaitingReview: 1,
            running: 0,
            lastLaunchAt: "2026-10-02T12:00:00.000Z",
          },
          {
            nodeName: "Ada",
            localPath: "/Users/ada/Alpha",
            pathExists: true,
            git: { branch: "feat", dirty: true, ahead: 1, behind: 0, hasUpstream: true },
            awaitingReview: 0,
            running: 1,
            lastLaunchAt: "2026-10-04T00:00:00.000Z",
          },
        ],
      },
      {
        project: project({ id: "beta", name: "Beta", updatedAt: "2026-10-01T00:00:00.000Z" }),
        handoff: null,
        nodes: [
          {
            nodeName: "Ada",
            localPath: null,
            pathExists: false,
            git: null,
            awaitingReview: 0,
            running: 0,
            lastLaunchAt: null,
          },
        ],
      },
    ]);
  });

  it("keeps the first shared record when updatedAt ties, and later snapshots win the same nodeName", () => {
    const first = project({ name: "First", updatedAt: "2026-10-02T00:00:00.000Z" });
    const second = project({ name: "Second", updatedAt: "2026-10-02T00:00:00.000Z" });
    expect(
      mergeHubProjectViews([
        snapshot({
          nodeName: "Steve",
          projects: [view({ project: first, localPath: "/old", pathExists: false })],
        }),
        snapshot({
          nodeName: "Steve",
          projects: [view({ project: second, localPath: "/new", pathExists: true, running: 2 })],
        }),
      ]),
    ).toEqual([
      {
        project: first,
        handoff: null,
        nodes: [
          {
            nodeName: "Steve",
            localPath: "/new",
            pathExists: true,
            git: null,
            awaitingReview: 0,
            running: 2,
            lastLaunchAt: null,
          },
        ],
      },
    ]);
  });

  it("contributes nothing for an empty snapshot list (unreachable nodes omitted by the caller)", () => {
    expect(mergeHubProjectViews([])).toEqual([]);
  });
});

describe("hubProjectViewForNode", () => {
  it("maps the selected node back to a single reporting HubProjectView", () => {
    const merged = mergeHubProjectViews([
      snapshot({
        nodeName: "Steve",
        projects: [view({ project: project({}), localPath: "/steve", pathExists: true })],
      }),
      snapshot({
        nodeName: "Ada",
        projects: [view({ project: project({}), running: 1 })],
      }),
    ])[0]!;
    expect(hubProjectViewForNode(merged, "Steve")).toEqual({
      project: project({}),
      localPath: "/steve",
      pathExists: true,
      git: null,
      awaitingReview: 0,
      running: 0,
      lastLaunchAt: null,
      handoff: null,
    });
    expect(hubProjectViewForNode(merged, "Ada").running).toBe(1);
    expect(hubProjectViewForNode(merged, "Missing")).toEqual({
      project: project({}),
      localPath: null,
      pathExists: false,
      git: null,
      awaitingReview: 0,
      running: 0,
      lastLaunchAt: null,
      handoff: null,
    });
    expect(mergedProjectLastLaunchAt(merged)).toBe(null);
  });

  it("keeps the newer handoff, and a value beats null", () => {
    const older: TestHandoff = {
      version: 1,
      kind: "ready",
      projectId: "alpha",
      updatedAt: "2026-10-02T00:00:00.000Z",
      sourceThreadId: ThreadId.make("thread-old"),
      sourceStage: "develop",
      nodeName: "Steve",
      finishedAt: "2026-10-02T00:00:00.000Z",
    };
    const newer: TestHandoff = { ...older, updatedAt: "2026-10-04T00:00:00.000Z", nodeName: "Ada" };
    const merged = mergeHubProjectViews([
      snapshot({
        nodeName: "Steve",
        projects: [view({ project: project({}), handoff: older })],
      }),
      snapshot({
        nodeName: "Ada",
        projects: [view({ project: project({}), handoff: newer })],
      }),
    ])[0]!;
    expect(merged.handoff).toEqual(newer);
    expect(hubProjectViewForNode(merged, "Steve").handoff).toEqual(newer);

    const valueBeatsNull = mergeHubProjectViews([
      snapshot({
        nodeName: "Ada",
        projects: [
          view({ project: project({ updatedAt: "2026-10-09T00:00:00.000Z" }), handoff: null }),
        ],
      }),
      snapshot({
        nodeName: "Steve",
        projects: [view({ project: project({}), handoff: older })],
      }),
    ])[0]!;
    expect(valueBeatsNull.handoff).toEqual(older);
  });
});

const decodeHubProject = Schema.decodeSync(HubProjectSchema);
const decodeHubProjectView = Schema.decodeSync(HubProjectViewSchema);

describe("HubProject decode", () => {
  it("decodes an old project JSON object that omits lane and jobKind", () => {
    const decoded = decodeHubProject({
      id: "alpha",
      name: "Alpha",
      priority: "medium",
      status: "active",
      stage: "develop",
      strategyId: null,
      category: null,
      tags: [],
      repoUrl: null,
      notes: "",
      hosts: {},
      autonomy: 0,
      reviewBudget: 2,
      sortIndex: 0,
      favorite: false,
      archived: false,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(decoded.lane).toBeNull();
    expect(decoded.jobKind).toBe("dev");

    const view = decodeHubProjectView({
      project: decoded,
      localPath: null,
      pathExists: false,
      git: null,
      awaitingReview: 0,
      running: 0,
      lastLaunchAt: null,
    });
    expect(view.handoff).toBeNull();
  });
});

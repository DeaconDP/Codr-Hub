import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_HUB_SETTINGS,
  HubProject,
  HubProjectHost,
  hubProjectViewForNode,
  mergeHubProjectViews,
  mergedProjectLastLaunchAt,
  type HubProject as HubProjectType,
  type HubProjectView,
  type HubSnapshot,
} from "./codrHub.ts";

const project = (overrides: Partial<HubProjectType>): HubProjectType => ({
  id: "alpha",
  name: "Alpha",
  priority: "medium",
  status: "active",
  stage: "develop",
  strategyId: null,
  category: null,
  tags: [],
  repoUrl: null,
  previewUrl: null,
  liveUrl: null,
  siteId: null,
  surface: null,
  notes: "",
  hosts: {},
  autonomy: 0,
  reviewBudget: 2,
  sortIndex: 0,
  favorite: false,
  archived: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const view = (
  overrides: Partial<HubProjectView> & { project: HubProjectType },
): HubProjectView => ({
  localPath: null,
  pathExists: false,
  git: null,
  awaitingReview: 0,
  running: 0,
  lastLaunchAt: null,
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
      hosts: { Steve: { path: "/Users/steve/Alpha", stickyPort: null, launchCmd: null } },
      updatedAt: "2026-10-02T00:00:00.000Z",
    });
    const adaProject = project({
      name: "Alpha from Ada",
      hosts: { Ada: { path: "/Users/ada/Alpha", stickyPort: null, launchCmd: null } },
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

describe("HubProject site-fleet decode defaults", () => {
  it("fills missing shared fleet fields and host sticky/launch with null", () => {
    const decoded = Schema.decodeSync(HubProject)({
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
      hosts: { Steve: { path: "/Users/steve/Alpha" } },
      autonomy: 0,
      reviewBudget: 2,
      sortIndex: 0,
      favorite: false,
      archived: false,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(decoded).toMatchObject({
      previewUrl: null,
      liveUrl: null,
      siteId: null,
      surface: null,
      hosts: { Steve: { path: "/Users/steve/Alpha", stickyPort: null, launchCmd: null } },
    });
  });

  it("keeps explicit fleet values on project and host", () => {
    const host = Schema.decodeSync(HubProjectHost)({
      path: "/work",
      stickyPort: 5173,
      launchCmd: "npm run dev",
    });
    expect(host).toEqual({ path: "/work", stickyPort: 5173, launchCmd: "npm run dev" });
    const decoded = Schema.decodeSync(HubProject)({
      id: "alpha",
      name: "Alpha",
      priority: "medium",
      status: "active",
      stage: "develop",
      strategyId: null,
      category: null,
      tags: [],
      repoUrl: null,
      previewUrl: "https://preview.example",
      liveUrl: "https://live.example",
      siteId: "emily",
      surface: "site",
      notes: "",
      hosts: { Steve: host },
      autonomy: 0,
      reviewBudget: 2,
      sortIndex: 0,
      favorite: false,
      archived: false,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(decoded.previewUrl).toBe("https://preview.example");
    expect(decoded.hosts.Steve).toEqual(host);
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
    });
    expect(mergedProjectLastLaunchAt(merged)).toBe(null);
  });
});

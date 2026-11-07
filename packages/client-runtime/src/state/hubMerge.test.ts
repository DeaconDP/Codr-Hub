import { EnvironmentId, type HubProjectView, type HubSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { createHubMergedProjectsAtomFamily, hubMergedProjectsKey } from "./hubMerge.ts";

const STEVE = EnvironmentId.make("steve");
const UNITY = EnvironmentId.make("unity");
const UNREAL = EnvironmentId.make("unreal");
const UNITY_T3 = EnvironmentId.make("unity-t3");
const UNREAL_T3 = EnvironmentId.make("unreal-t3");

const snapshot = (
  nodeName: string,
  projectIds: ReadonlyArray<string>,
  t3Sources: ReadonlyArray<{ environmentId: EnvironmentId; nodeName: string }> = [],
) =>
  ({
    nodeName,
    t3Sync: { t3Sources },
    projects: projectIds.map(
      (id) =>
        ({
          project: { id, name: id, updatedAt: "2026-11-01T00:00:00.000Z" },
          localPath: null,
          pathExists: false,
          git: null,
          awaitingReview: 0,
          running: 0,
          lastLaunchAt: null,
          handoff: null,
        }) as HubProjectView,
    ),
  }) as unknown as HubSnapshot;

describe("hubMergedProjects", () => {
  it("keeps a reconnecting environment's last snapshot without waiting on it", () => {
    // What each hubLive stream atom holds: Steve's server restarted, so its
    // stream waits with the snapshot it had; Unreal has never answered.
    const results = new Map<EnvironmentId, AsyncResult.AsyncResult<HubSnapshot, unknown>>([
      [
        STEVE,
        AsyncResult.success(
          snapshot(
            "Steve",
            ["codr-hub", "deez"],
            [
              { environmentId: UNITY, nodeName: "Steve" },
              { environmentId: UNREAL_T3, nodeName: "EpicUnrealPC" },
            ],
          ),
          { waiting: true },
        ),
      ],
      [
        UNITY,
        AsyncResult.success(
          snapshot("EpicUnityPC", [], [{ environmentId: UNITY_T3, nodeName: "EpicUnityPC" }]),
        ),
      ],
      [UNREAL, AsyncResult.initial(true)],
    ]);
    const hubLive = Atom.family((environmentId: EnvironmentId) =>
      Atom.make(results.get(environmentId)!),
    );
    const merged = createHubMergedProjectsAtomFamily((target) => hubLive(target.environmentId));
    const key = hubMergedProjectsKey([
      { environmentId: STEVE, phase: "reconnecting" },
      { environmentId: UNITY, phase: "connected" },
      { environmentId: UNREAL, phase: "reconnecting" },
      { environmentId: EnvironmentId.make("disabled"), phase: "available" },
    ]);

    expect(key).not.toBeNull();
    const value = AtomRegistry.make().get(merged.family(key!));
    expect(value.projects.map((view) => view.project.id)).toEqual(["codr-hub", "deez"]);
    expect(value.nodeNameByEnvironmentId.get(STEVE)).toBe("Steve");
    // Unity's Hub reads the stock T3 beside it; Steve's sources name an environment that is a
    // Hub (skipped) and Unreal's stock T3, which has no Hub of its own.
    expect([...value.nodeNameByEnvironmentId]).toEqual([
      [STEVE, "Steve"],
      [UNITY, "EpicUnityPC"],
      [UNREAL_T3, "EpicUnrealPC"],
      [UNITY_T3, "EpicUnityPC"],
    ]);
    expect(value.isPending).toBe(false);
    expect(hubMergedProjectsKey([{ environmentId: UNITY, phase: "available" }])).toBeNull();
  });
});

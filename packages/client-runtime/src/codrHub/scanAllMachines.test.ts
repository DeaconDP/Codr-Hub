import { EnvironmentId, type HubMergedProjectView } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { runScanAll, scanAllPlan } from "./scanAllMachines.ts";

const STEVE = EnvironmentId.make("steve");
const STEVE_AGAIN = EnvironmentId.make("steve-tailnet");
const UNITY = EnvironmentId.make("unity");
const UNITY_T3 = EnvironmentId.make("unity-t3");
const LAPTOP = EnvironmentId.make("laptop");

const view = (hosts: ReadonlyArray<string>, nodes: ReadonlyArray<string> = []) =>
  ({
    project: { hosts: Object.fromEntries(hosts.map((node) => [node, {}])) },
    nodes: nodes.map((nodeName) => ({ nodeName })),
  }) as unknown as HubMergedProjectView;

describe("scanAllPlan", () => {
  it("scans one connected Hub per machine and lists machines it cannot reach", () => {
    const plan = scanAllPlan({
      hubEnvironmentIds: [STEVE, STEVE_AGAIN, UNITY, LAPTOP],
      connectedEnvironmentIds: [STEVE, STEVE_AGAIN, UNITY, UNITY_T3],
      nodeNameByEnvironmentId: new Map([
        [STEVE, "Steve"],
        [STEVE_AGAIN, "Steve"],
        [UNITY, "EpicUnityPC"],
        [LAPTOP, "Laptop"],
        [UNITY_T3, "EpicUnityPC"],
      ]),
      projects: [view(["Steve", "EpicUnrealPC"], ["Steve"]), view(["Laptop"])],
    });
    expect(plan.targets).toEqual([
      { environmentId: UNITY, nodeName: "EpicUnityPC" },
      { environmentId: STEVE, nodeName: "Steve" },
    ]);
    expect(plan.unreachable).toEqual(["EpicUnrealPC", "Laptop"]);
  });
});

describe("runScanAll", () => {
  it("reports each machine's summary, error, or that its Hub is too old", async () => {
    const lines = await runScanAll(
      {
        targets: [
          { environmentId: STEVE, nodeName: "Steve" },
          { environmentId: UNITY, nodeName: "EpicUnityPC" },
          { environmentId: LAPTOP, nodeName: "Laptop" },
        ],
        unreachable: ["EpicUnrealPC"],
      },
      async ({ environmentId }) =>
        environmentId === STEVE
          ? AsyncResult.success({ imported: 1, updated: 0, skipped: 2, rows: 3, matched: 0 })
          : AsyncResult.failure(
              Cause.fail(
                new Error(
                  environmentId === UNITY
                    ? 'Expected "deez-project-manager", got "scan"'
                    : "Scan settings are invalid.",
                ),
              ),
            ),
    );
    expect(lines.map((line) => [line.nodeName, line.ok, line.text])).toEqual([
      [
        "Steve",
        true,
        "Added 1 new, matched 0, 0 machine checkouts, 0 updated, 2 skipped from 3 rows.",
      ],
      ["EpicUnityPC", false, "Needs the latest Codr-Hub to scan."],
      ["Laptop", false, "Scan settings are invalid."],
      ["EpicUnrealPC", false, "Not reachable: run `npm run codr:scan` there and import the file."],
    ]);
  });
});

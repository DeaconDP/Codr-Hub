/**
 * Test handoff for one project. Pure. Settle is not an event, so auto-settle
 * cannot clear the file.
 *
 * @module codrHub/testHandoff
 */
import {
  projectMatchesLane,
  type HubSdlcMode,
  type HubSdlcStage,
  type TestHandoff,
  type ThreadId,
} from "@t3tools/contracts";

export { projectMatchesLane };

export const TEST_HANDOFF_EVENTS = ["threadFinished", "ship", "fix", "consumed"] as const;
export type TestHandoffEventType = (typeof TEST_HANDOFF_EVENTS)[number];

export function ownerTryStage(mode: HubSdlcMode): HubSdlcStage {
  return mode === "three" ? "develop" : "test";
}

export type ThreadFinishedEvent = {
  readonly type: "threadFinished";
  readonly projectId: string;
  readonly threadId: ThreadId;
  readonly stage: HubSdlcStage;
  readonly mode: HubSdlcMode;
  readonly nodeName: string;
  readonly finishedAt: string;
  readonly updatedAt: string;
};

export type ShipHandoffEvent = {
  readonly type: "ship";
  readonly updatedAt: string;
};

export type FixHandoffEvent = {
  readonly type: "fix";
  readonly note: string;
  readonly notedAt: string;
  readonly updatedAt: string;
};

export type ConsumedHandoffEvent = {
  readonly type: "consumed";
  readonly byThreadId: ThreadId;
  readonly updatedAt: string;
};

export type TestHandoffEvent =
  | ThreadFinishedEvent
  | ShipHandoffEvent
  | FixHandoffEvent
  | ConsumedHandoffEvent;

const kept = (handoff: TestHandoff) => ({
  version: 1 as const,
  projectId: handoff.projectId,
  sourceThreadId: handoff.sourceThreadId,
  sourceStage: handoff.sourceStage,
  nodeName: handoff.nodeName,
  finishedAt: handoff.finishedAt,
});

export function reduceTestHandoff(
  current: TestHandoff | null,
  event: TestHandoffEvent,
): TestHandoff | null {
  switch (event.type) {
    case "threadFinished":
      return reduceThreadFinished(current, event);
    case "ship":
      return reduceShip(current, event);
    case "fix":
      return reduceFix(current, event);
    case "consumed":
      return reduceConsumed(current, event);
  }
}

function reduceThreadFinished(
  current: TestHandoff | null,
  event: ThreadFinishedEvent,
): TestHandoff | null {
  if (event.stage !== ownerTryStage(event.mode)) return current;
  if (current !== null && current.sourceThreadId === event.threadId) return current;
  if (current?.kind === "ready" || current?.kind === "fix") return current;
  if (
    current?.kind === "cleared" &&
    current.reason === "consumed" &&
    current.byThreadId !== event.threadId
  ) {
    return current;
  }
  return {
    version: 1,
    kind: "ready",
    projectId: event.projectId,
    updatedAt: event.updatedAt,
    sourceThreadId: event.threadId,
    sourceStage: event.stage,
    nodeName: event.nodeName,
    finishedAt: event.finishedAt,
  };
}

function reduceShip(current: TestHandoff | null, event: ShipHandoffEvent): TestHandoff | null {
  if (current?.kind !== "ready" && current?.kind !== "fix") return current;
  return {
    ...kept(current),
    kind: "cleared",
    reason: "ship",
    updatedAt: event.updatedAt,
  };
}

function reduceFix(current: TestHandoff | null, event: FixHandoffEvent): TestHandoff | null {
  if (current?.kind !== "ready" && current?.kind !== "fix") return current;
  const note = event.note.trim();
  if (note.length === 0 || note.length > 500) return current;
  return {
    ...kept(current),
    kind: "fix",
    note,
    notedAt: event.notedAt,
    updatedAt: event.updatedAt,
  };
}

function reduceConsumed(
  current: TestHandoff | null,
  event: ConsumedHandoffEvent,
): TestHandoff | null {
  if (current?.kind !== "fix") return current;
  return {
    ...kept(current),
    kind: "cleared",
    reason: "consumed",
    note: current.note,
    byThreadId: event.byThreadId,
    updatedAt: event.updatedAt,
  };
}

export function handoffBlocksLaunch(
  handoff: TestHandoff | null,
  consumingThreadOutstanding: boolean,
): boolean {
  if (handoff === null) return false;
  if (handoff.kind === "ready") return true;
  if (handoff.kind === "cleared" && handoff.reason === "consumed")
    return consumingThreadOutstanding;
  return false;
}

export function visibleTestHandoff(
  handoff: TestHandoff | null,
): Extract<TestHandoff, { kind: "ready" | "fix" }> | null {
  if (handoff?.kind === "ready" || handoff?.kind === "fix") return handoff;
  return null;
}

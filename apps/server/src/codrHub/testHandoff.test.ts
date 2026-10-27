import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  TEST_HANDOFF_EVENTS,
  handoffBlocksLaunch,
  ownerTryStage,
  projectMatchesLane,
  reduceTestHandoff,
  visibleTestHandoff,
  type ThreadFinishedEvent,
} from "./testHandoff.ts";

const thread = (id: string) => ThreadId.make(id);

const finished = (overrides: Partial<ThreadFinishedEvent> = {}): ThreadFinishedEvent => ({
  type: "threadFinished",
  projectId: "alpha",
  threadId: thread("thread-a"),
  stage: "develop",
  mode: "three",
  nodeName: "Steve",
  finishedAt: "2026-10-20T12:00:00.000Z",
  updatedAt: "2026-10-20T12:00:00.000Z",
  ...overrides,
});

describe("test handoff", () => {
  it("maps the owner-try stage and arms ready only there", () => {
    expect(ownerTryStage("three")).toBe("develop");
    expect(ownerTryStage("six")).toBe("test");
    expect(reduceTestHandoff(null, finished())?.kind).toBe("ready");
    expect(reduceTestHandoff(null, finished({ stage: "develop", mode: "six" }))).toBeNull();
    expect(reduceTestHandoff(null, finished({ stage: "test", mode: "six" }))?.kind).toBe("ready");
  });

  it("ignores the same thread finishing again, including updatedAt", () => {
    const ready = reduceTestHandoff(null, finished());
    const again = reduceTestHandoff(
      ready,
      finished({
        updatedAt: "2026-10-21T00:00:00.000Z",
        finishedAt: "2026-10-21T00:00:00.000Z",
      }),
    );
    expect(again).toBe(ready);
    expect(again?.updatedAt).toBe("2026-10-20T12:00:00.000Z");
  });

  it("does not replace a ready handoff with a different thread", () => {
    const ready = reduceTestHandoff(null, finished());
    expect(
      reduceTestHandoff(ready, finished({ threadId: thread("thread-b"), updatedAt: "later" })),
    ).toBe(ready);
  });

  it("ships from ready or fix and does not start a launch", () => {
    const ready = reduceTestHandoff(null, finished())!;
    const shipped = reduceTestHandoff(ready, {
      type: "ship",
      updatedAt: "2026-10-20T13:00:00.000Z",
    });
    expect(shipped).toEqual({
      version: 1,
      kind: "cleared",
      reason: "ship",
      projectId: ready.projectId,
      sourceThreadId: ready.sourceThreadId,
      sourceStage: ready.sourceStage,
      nodeName: ready.nodeName,
      finishedAt: ready.finishedAt,
      updatedAt: "2026-10-20T13:00:00.000Z",
    });
    expect(shipped).not.toHaveProperty("byThreadId");

    const fix = reduceTestHandoff(ready, {
      type: "fix",
      note: "Tighten the empty state",
      notedAt: "2026-10-20T13:00:00.000Z",
      updatedAt: "2026-10-20T13:00:00.000Z",
    })!;
    expect(
      reduceTestHandoff(fix, { type: "ship", updatedAt: "2026-10-20T14:00:00.000Z" }),
    ).toMatchObject({ kind: "cleared", reason: "ship", sourceThreadId: ready.sourceThreadId });
  });

  it("stores a fix note from ready, and a new note on an existing fix", () => {
    const ready = reduceTestHandoff(null, finished())!;
    const fix = reduceTestHandoff(ready, {
      type: "fix",
      note: "  Tighten the empty state  ",
      notedAt: "2026-10-20T13:00:00.000Z",
      updatedAt: "2026-10-20T13:00:00.000Z",
    });
    expect(fix).toMatchObject({
      kind: "fix",
      note: "Tighten the empty state",
      notedAt: "2026-10-20T13:00:00.000Z",
    });
    const revised = reduceTestHandoff(fix, {
      type: "fix",
      note: "Also the button label",
      notedAt: "2026-10-20T15:00:00.000Z",
      updatedAt: "2026-10-20T15:00:00.000Z",
    });
    expect(revised).toMatchObject({ kind: "fix", note: "Also the button label" });
  });

  it("has no settled event, so auto-settle cannot clear a ready handoff", () => {
    expect([...TEST_HANDOFF_EVENTS]).toEqual(["threadFinished", "ship", "fix", "consumed"]);
    const ready = reduceTestHandoff(null, finished());
    expect(ready?.kind).toBe("ready");
  });

  it("records that a fix note was copied into a reserved launch", () => {
    const ready = reduceTestHandoff(null, finished())!;
    const fix = reduceTestHandoff(ready, {
      type: "fix",
      note: "Tighten the empty state",
      notedAt: "2026-10-20T13:00:00.000Z",
      updatedAt: "2026-10-20T13:00:00.000Z",
    })!;
    const consumed = reduceTestHandoff(fix, {
      type: "consumed",
      byThreadId: thread("thread-b"),
      updatedAt: "2026-10-20T14:00:00.000Z",
    });
    expect(consumed).toMatchObject({
      kind: "cleared",
      reason: "consumed",
      note: "Tighten the empty state",
      byThreadId: thread("thread-b"),
    });
    expect(
      reduceTestHandoff(ready, {
        type: "consumed",
        byThreadId: thread("thread-b"),
        updatedAt: "x",
      }),
    ).toBe(ready);
  });

  it("blocks launch for ready, and for a consumed fix while that thread is outstanding", () => {
    const ready = reduceTestHandoff(null, finished());
    expect(handoffBlocksLaunch(ready, false)).toBe(true);
    expect(handoffBlocksLaunch(null, true)).toBe(false);
    const fix = reduceTestHandoff(ready, {
      type: "fix",
      note: "Tighten the empty state",
      notedAt: "2026-10-20T13:00:00.000Z",
      updatedAt: "2026-10-20T13:00:00.000Z",
    });
    expect(handoffBlocksLaunch(fix, true)).toBe(false);
    const consumed = reduceTestHandoff(fix, {
      type: "consumed",
      byThreadId: thread("thread-b"),
      updatedAt: "2026-10-20T14:00:00.000Z",
    });
    expect(handoffBlocksLaunch(consumed, true)).toBe(true);
    expect(handoffBlocksLaunch(consumed, false)).toBe(false);
    const shipped = reduceTestHandoff(ready, {
      type: "ship",
      updatedAt: "2026-10-20T13:00:00.000Z",
    });
    expect(handoffBlocksLaunch(shipped, true)).toBe(false);
  });

  it("shows ready and fix, and hides cleared handoffs", () => {
    const ready = reduceTestHandoff(null, finished());
    expect(visibleTestHandoff(ready)?.kind).toBe("ready");
    const fix = reduceTestHandoff(ready, {
      type: "fix",
      note: "Tighten the empty state",
      notedAt: "2026-10-20T13:00:00.000Z",
      updatedAt: "2026-10-20T13:00:00.000Z",
    });
    expect(visibleTestHandoff(fix)?.kind).toBe("fix");
    expect(
      visibleTestHandoff(reduceTestHandoff(ready, { type: "ship", updatedAt: "t" })),
    ).toBeNull();
    expect(visibleTestHandoff(null)).toBeNull();
  });

  it("matches every project for the empty lane filter, and only that lane otherwise", () => {
    const immersion = { lane: "immersion" as const };
    const missing = { lane: null };
    expect(projectMatchesLane(immersion, null)).toBe(true);
    expect(projectMatchesLane(missing, null)).toBe(true);
    expect(projectMatchesLane(immersion, "immersion")).toBe(true);
    expect(projectMatchesLane(immersion, "automation")).toBe(false);
    expect(projectMatchesLane(missing, "publicity")).toBe(false);
  });

  it("lets the consuming thread arm ready again, and leaves a different thread consumed", () => {
    const ready = reduceTestHandoff(null, finished())!;
    const fix = reduceTestHandoff(ready, {
      type: "fix",
      note: "Tighten the empty state",
      notedAt: "2026-10-20T13:00:00.000Z",
      updatedAt: "2026-10-20T13:00:00.000Z",
    })!;
    const consumed = reduceTestHandoff(fix, {
      type: "consumed",
      byThreadId: thread("thread-b"),
      updatedAt: "2026-10-20T14:00:00.000Z",
    });
    expect(reduceTestHandoff(consumed, finished({ threadId: thread("thread-c") }))).toBe(consumed);
    expect(reduceTestHandoff(consumed, finished({ threadId: thread("thread-b") }))?.kind).toBe(
      "ready",
    );
    const shipped = reduceTestHandoff(ready, {
      type: "ship",
      updatedAt: "2026-10-20T13:00:00.000Z",
    });
    expect(reduceTestHandoff(shipped, finished({ threadId: thread("thread-c") }))?.kind).toBe(
      "ready",
    );
  });
});

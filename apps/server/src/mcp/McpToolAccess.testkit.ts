import { ProjectId, ProviderInstanceId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

/**
 * A thread shell the access gate reads as a live caller: an active run on the
 * `codex` provider instance, full-access/default. Tests that exercise a tool
 * rather than the gate can treat every caller as allowed.
 */
export const liveThreadShell = (threadId: ThreadId) =>
  ({
    id: threadId,
    projectId: ProjectId.make("project:mcp-test"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access",
    interactionMode: "default",
    activeRunId: "run:mcp-test",
    archivedAt: null,
    deletedAt: null,
  }) as unknown as NonNullable<
    Effect.Success<
      ReturnType<ThreadManagement.ThreadManagementService["Service"]["getThreadShell"]>
    >
  >;

/** `ThreadManagementService` that only answers the gate's thread lookups, all live. */
export const liveThreadsLayer = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
});

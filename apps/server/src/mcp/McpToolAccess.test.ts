import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { DeviceToolkit } from "./toolkits/device/tools.ts";
import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const supervisedThreadId = ThreadId.make("thread:supervised");
const fullAccessThreadId = ThreadId.make("thread:full-access");
const planThreadId = ThreadId.make("thread:plan");
const endedThreadId = ThreadId.make("thread:ended");

const shell = (
  id: ThreadId,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  activeRunId: string | null = "run:live",
) =>
  ({ ...liveThreadShell(id), runtimeMode, interactionMode, activeRunId }) as ReturnType<
    typeof liveThreadShell
  >;

const shells = new Map([
  [supervisedThreadId, shell(supervisedThreadId, "approval-required", "default")],
  [fullAccessThreadId, shell(fullAccessThreadId, "full-access", "default")],
  [planThreadId, shell(planThreadId, "approval-required", "plan")],
  [endedThreadId, shell(endedThreadId, "full-access", "default", null)],
]);

const threadCaller = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const clientCaller = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Claude Code", access },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const check = (
  tool: string,
  scope: McpInvocationContext.McpInvocationScope,
  input: McpToolAccess.ToolInput = {},
) =>
  McpToolAccess.checkAccess(McpToolAccess.TOOL_ACCESS[tool]!, scope, input, (threadId) =>
    Effect.succeed(shells.get(threadId)),
  ).pipe(
    Effect.exit,
    Effect.map((exit) =>
      Exit.isSuccess(exit)
        ? "allowed"
        : Exit.findErrorOption(exit).pipe((error) =>
            error._tag === "Some" ? error.value.code : "died",
          ),
    ),
  );

it("lists every registered tool, and nothing else", () => {
  const registered = [
    AttachmentToolkit,
    DeviceToolkit,
    EnvironmentToolkit,
    OrchestratorToolkit,
    PreviewToolkit,
    PreviewControlsToolkit,
    ProjectToolkit,
    PullRequestsToolkit,
    ThreadToolkit,
    WorktreeToolkit,
  ].flatMap((toolkit) => Object.keys(toolkit.tools));
  expect(Object.keys(McpToolAccess.TOOL_ACCESS).toSorted()).toEqual(registered.toSorted());
});

it.effect("each kind of caller gets exactly what its limits allow", () =>
  Effect.gen(function* () {
    const supervised = threadCaller(supervisedThreadId);
    const fullAccess = threadCaller(fullAccessThreadId);
    const plan = threadCaller(planThreadId);
    const ended = threadCaller(endedThreadId);
    const readOnly = clientCaller("read-only");
    const supervisedClient = clientCaller("approval-required");
    const fullAccessClient = clientCaller("full-access");

    const table: ReadonlyArray<
      readonly [string, McpInvocationContext.McpInvocationScope, McpToolAccess.ToolInput, string]
    > = [
      // Reads are open to every caller, even one whose run ended.
      ["t3_thread_read", readOnly, { threadId: fullAccessThreadId }, "allowed"],
      ["t3_thread_list", ended, {}, "allowed"],

      // Launching: within the caller's own modes, never above them.
      ["t3_thread_launch", supervised, {}, "allowed"],
      ["t3_thread_launch", supervised, { runtimeMode: "approval-required" }, "allowed"],
      [
        "t3_thread_launch",
        supervised,
        { runtimeMode: "full-access" },
        "runtime_mode_escalation_denied",
      ],
      ["t3_thread_launch", plan, {}, "allowed"],
      [
        "t3_thread_launch",
        plan,
        { interactionMode: "default" },
        "interaction_mode_escalation_denied",
      ],
      ["t3_thread_launch", fullAccess, { runtimeMode: "full-access" }, "allowed"],
      ["t3_thread_launch", ended, {}, "parent_not_active"],
      ["t3_thread_launch", readOnly, {}, "capability_denied"],
      [
        "t3_thread_launch",
        supervisedClient,
        { runtimeMode: "auto" },
        "runtime_mode_escalation_denied",
      ],
      ["t3_thread_launch", fullAccessClient, { runtimeMode: "full-access" }, "allowed"],
      ["schedule_task", supervised, {}, "allowed"],
      ["schedule_task", readOnly, {}, "capability_denied"],

      // Changing a thread: only one that runs within the caller's modes.
      ["t3_thread_send", supervised, {}, "allowed"],
      ["t3_thread_send", supervised, { threadId: planThreadId }, "allowed"],
      [
        "t3_thread_send",
        supervised,
        { threadId: fullAccessThreadId },
        "runtime_mode_escalation_denied",
      ],
      [
        "t3_thread_send",
        plan,
        { threadId: supervisedThreadId },
        "interaction_mode_escalation_denied",
      ],
      ["t3_thread_send", fullAccess, { threadId: supervisedThreadId }, "allowed"],
      ["t3_thread_send", ended, { threadId: supervisedThreadId }, "parent_not_active"],
      ["t3_thread_send", readOnly, { threadId: supervisedThreadId }, "capability_denied"],
      ["t3_thread_send", supervisedClient, { threadId: supervisedThreadId }, "allowed"],
      [
        "t3_thread_send",
        supervisedClient,
        { threadId: fullAccessThreadId },
        "runtime_mode_escalation_denied",
      ],
      // An unknown thread is the tool's to report.
      ["t3_thread_send", supervised, { threadId: "thread:missing" }, "allowed"],
      [
        "link_pull_request",
        supervised,
        { threadId: fullAccessThreadId },
        "runtime_mode_escalation_denied",
      ],
      [
        "t3_thread_merge_back",
        supervised,
        { targetThreadId: supervisedThreadId, sourceThreadId: fullAccessThreadId },
        "runtime_mode_escalation_denied",
      ],
      ["t3_attachment_prepare_upload", supervised, {}, "allowed"],
      ["t3_attachment_prepare_upload", readOnly, {}, "capability_denied"],

      // Projects and environment settings need full access.
      ["t3_project_create", fullAccess, {}, "allowed"],
      ["t3_project_create", supervised, {}, "capability_denied"],
      ["t3_project_create", fullAccessClient, {}, "allowed"],
      ["t3_project_create", supervisedClient, {}, "capability_denied"],
      ["run_scheduled_task_now", supervised, {}, "capability_denied"],

      // Tools that act as the calling thread need one.
      ["delegate_task", supervised, {}, "allowed"],
      ["delegate_task", ended, {}, "parent_not_active"],
      ["delegate_task", fullAccessClient, {}, "thread_credential_required"],
      ["t3_worktree_handoff", ended, {}, "parent_not_active"],
      ["preview_snapshot", ended, {}, "allowed"],
      ["preview_snapshot", fullAccessClient, {}, "thread_credential_required"],
      ["device_open", supervised, {}, "allowed"],
    ];
    for (const [tool, scope, input, expected] of table) {
      const caller = scope.thread?.threadId ?? `client:${scope.client?.access}`;
      expect([tool, caller, input, yield* check(tool, scope, input)]).toEqual([
        tool,
        caller,
        input,
        expected,
      ]);
    }
  }),
);

it.effect("refuses the call when a thread cannot be read", () =>
  Effect.gen(function* () {
    const result = yield* McpToolAccess.checkAccess(
      McpToolAccess.TOOL_ACCESS.t3_thread_send!,
      clientCaller("full-access"),
      { threadId: supervisedThreadId },
      () => Effect.fail(McpToolAccess.shellLookupFailed),
    ).pipe(Effect.flip);
    expect(result.code).toBe("orchestration_error");
  }),
);

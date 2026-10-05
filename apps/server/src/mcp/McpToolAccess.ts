import type {
  OrchestrationV2ThreadShell,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { McpSchema, type McpServer } from "effect/unstable/ai";

import * as McpInvocationContext from "./McpInvocationContext.ts";

/**
 * What a tool does, and so what its caller must be allowed:
 *
 * - `read`: changes nothing.
 * - `write`: changes the threads `threads` names (an omitted id means the
 *   caller's own thread), or something that belongs to no thread, like a
 *   pending upload.
 * - `start`: starts threads with the modes `modes` requests.
 * - `environment`: changes projects or environment settings.
 * - `as-caller`: acts as the calling T3 thread (its subagents, preview tabs,
 *   devices, worktree). `changes` says whether it changes anything.
 *
 * The gate checks the caller before the handler runs. Handlers still check
 * what only they can see, such as a queued run or task belonging to its
 * thread.
 */
export type ToolAccess =
  | { readonly kind: "read" }
  | { readonly kind: "write"; readonly threads: (input: ToolInput) => ReadonlyArray<unknown> }
  | { readonly kind: "start"; readonly modes: (input: ToolInput) => ReadonlyArray<RequestedModes> }
  | { readonly kind: "environment" }
  | { readonly kind: "as-caller"; readonly changes: boolean };

/** A tool's arguments as the client sent them, before the tool decodes them. */
export type ToolInput = Readonly<Record<string, unknown>>;

export interface RequestedModes {
  readonly runtimeMode?: unknown;
  readonly interactionMode?: unknown;
}

const read: ToolAccess = { kind: "read" };
/** Changes `threadId`, or the caller's own thread when it is omitted. */
const threadWrite: ToolAccess = { kind: "write", threads: (input) => [input.threadId] };
/** Changes something that belongs to no thread. */
const write: ToolAccess = { kind: "write", threads: () => [] };
const environment: ToolAccess = { kind: "environment" };
const asCaller: ToolAccess = { kind: "as-caller", changes: true };
const readsAsCaller: ToolAccess = { kind: "as-caller", changes: false };

/**
 * Every tool on `/mcp` and what it may do. Registration refuses a tool that is
 * not listed, so a new tool cannot ship without a decision here.
 */
export const TOOL_ACCESS: Readonly<Record<string, ToolAccess>> = {
  // Environment and projects
  orchestrator_capabilities: read,
  t3_environment_read: read,
  t3_environment_preferences_update: environment,
  t3_project_list: read,
  t3_project_read: read,
  t3_project_create: environment,
  t3_project_update: environment,
  t3_project_delete: environment,
  t3_project_clone: environment,
  run_scheduled_task_now: environment,

  // Starting threads
  t3_thread_launch: {
    kind: "start",
    modes: (input) => [{ runtimeMode: input.runtimeMode, interactionMode: input.interactionMode }],
  },
  // A scheduled task runs with the caller's own modes.
  schedule_task: { kind: "start", modes: () => [{}] },
  update_scheduled_task: write,
  delete_scheduled_task: write,
  list_scheduled_tasks: read,

  // Threads
  t3_thread_list: read,
  t3_thread_search: read,
  t3_thread_read: read,
  t3_thread_wait: read,
  t3_thread_transfers: read,
  t3_thread_configuration: read,
  t3_thread_update: threadWrite,
  t3_thread_send: threadWrite,
  t3_thread_interrupt: threadWrite,
  t3_thread_organize: threadWrite,
  t3_thread_configure: threadWrite,
  t3_thread_fork: threadWrite,
  t3_thread_merge_back: {
    kind: "write",
    threads: (input) => [input.targetThreadId, input.sourceThreadId],
  },
  t3_queue_list: read,
  t3_queue_read: read,
  t3_queue_edit: threadWrite,
  t3_queue_cancel: threadWrite,
  t3_queue_reorder: threadWrite,
  t3_queue_promote_to_steer: threadWrite,
  t3_pending_request_list: read,
  t3_pending_request_read: read,
  t3_pending_request_respond: threadWrite,
  t3_attachment_prepare_upload: write,
  t3_attachment_discard: write,
  t3_thread_send_attachments: threadWrite,

  // Pull requests
  list_thread_pull_requests: read,
  link_pull_request: threadWrite,
  unlink_pull_request: threadWrite,
  watch_pull_request: threadWrite,
  unwatch_pull_request: threadWrite,

  // Worktrees
  t3_worktree_list: read,
  t3_worktree_status: readsAsCaller,
  t3_worktree_handoff: asCaller,

  // Subagents: a child always runs within its parent's modes.
  delegate_task: asCaller,
  create_threads: asCaller,
  task_status: asCaller,
  task_cancel: asCaller,

  // The calling thread's preview tabs and devices
  t3_preview_list: readsAsCaller,
  t3_preview_close: asCaller,
  preview_status: readsAsCaller,
  preview_snapshot: readsAsCaller,
  preview_wait_for: readsAsCaller,
  preview_open: asCaller,
  preview_navigate: asCaller,
  preview_resize: asCaller,
  preview_set_appearance: asCaller,
  preview_click: asCaller,
  preview_type: asCaller,
  preview_press: asCaller,
  preview_scroll: asCaller,
  preview_evaluate: asCaller,
  preview_recording_start: asCaller,
  preview_recording_stop: asCaller,
  device_list: readsAsCaller,
  device_screenshot: readsAsCaller,
  device_open: asCaller,
  device_close: asCaller,
};

/** The most a caller may hand to what it starts or changes. */
export interface CallerLimits {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

const RUNTIME_MODE_RANK: Readonly<Record<RuntimeMode, number>> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};
const INTERACTION_MODE_RANK: Readonly<Record<ProviderInteractionMode, number>> = {
  plan: 0,
  default: 1,
};

const isRuntimeMode = (value: unknown): value is RuntimeMode =>
  typeof value === "string" && Object.hasOwn(RUNTIME_MODE_RANK, value);
const isInteractionMode = (value: unknown): value is ProviderInteractionMode =>
  typeof value === "string" && Object.hasOwn(INTERACTION_MODE_RANK, value);

/** Why a call was refused, in the shape every T3 tool failure takes. */
export interface AccessDenial {
  readonly code:
    | "capability_denied"
    | "parent_not_active"
    | "runtime_mode_escalation_denied"
    | "interaction_mode_escalation_denied"
    | "thread_not_found"
    | "thread_credential_required"
    | "orchestration_error";
  readonly message: string;
}

export type ThreadShell = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "runtimeMode"
  | "interactionMode"
  | "activeRunId"
  | "archivedAt"
  | "deletedAt"
  | "providerInstanceId"
>;

/**
 * Reads a thread's shell for the gate: `undefined` when there is none, and
 * `shellLookupFailed` when it cannot be read, which refuses the call.
 */
export type ReadThreadShell = (
  threadId: ThreadId,
) => Effect.Effect<ThreadShell | undefined, AccessDenial>;

export const shellLookupFailed: AccessDenial = {
  code: "orchestration_error",
  message: "The operation could not be completed.",
};

const deny = (code: AccessDenial["code"], message: string) =>
  Effect.fail<AccessDenial>({ code, message });

const readOnlyDenial = deny(
  "capability_denied",
  "This tool changes the environment, and this MCP client was approved for read-only access.",
);

/**
 * The caller's limits: a thread caller's own modes, or the ceiling an OAuth
 * client was approved with. A thread caller must own a live run of a thread
 * that is not archived, so a provider token that outlived its session cannot
 * act.
 */
const callerLimits = (
  scope: McpInvocationContext.McpInvocationScope,
  readShell: ReadThreadShell,
): Effect.Effect<CallerLimits, AccessDenial> => {
  const thread = scope.thread;
  if (thread === undefined) {
    return Effect.succeed({
      runtimeMode: McpInvocationContext.clientRuntimeModeCeiling(scope.client),
      interactionMode: "default",
    });
  }
  return readShell(thread.threadId).pipe(
    Effect.flatMap((caller) =>
      caller === undefined || caller.deletedAt !== null
        ? deny("thread_not_found", "The calling thread was not found.")
        : caller.archivedAt !== null ||
            caller.activeRunId === null ||
            caller.providerInstanceId !== thread.providerInstanceId
          ? deny("parent_not_active", "The calling provider no longer owns an active thread run.")
          : Effect.succeed({
              runtimeMode: caller.runtimeMode,
              interactionMode: caller.interactionMode,
            }),
    ),
  );
};

const modesWithin = (
  limits: CallerLimits,
  modes: CallerLimits,
  subject: string,
): Effect.Effect<void, AccessDenial> =>
  RUNTIME_MODE_RANK[modes.runtimeMode] > RUNTIME_MODE_RANK[limits.runtimeMode]
    ? deny(
        "runtime_mode_escalation_denied",
        `${subject} runtime mode ${modes.runtimeMode} is broader than your mode ${limits.runtimeMode}.`,
      )
    : INTERACTION_MODE_RANK[modes.interactionMode] > INTERACTION_MODE_RANK[limits.interactionMode]
      ? deny(
          "interaction_mode_escalation_denied",
          `${subject} interaction mode ${modes.interactionMode} is broader than your mode ${limits.interactionMode}.`,
        )
      : Effect.void;

/**
 * Decides whether the caller in `scope` may call a tool with this access and
 * these arguments. Arguments that are not valid modes or thread ids are left
 * for the tool's own decoding to reject.
 */
export const checkAccess = (
  access: ToolAccess,
  scope: McpInvocationContext.McpInvocationScope,
  input: ToolInput,
  readShell: ReadThreadShell,
): Effect.Effect<void, AccessDenial> => {
  if (access.kind === "read") return Effect.void;
  if (access.kind === "as-caller") {
    if (scope.thread === undefined) {
      return deny(
        "thread_credential_required",
        "This tool acts as the calling T3 thread, so it needs an agent running inside T3 Code. This MCP client signed in from outside a thread.",
      );
    }
    return access.changes ? Effect.asVoid(callerLimits(scope, readShell)) : Effect.void;
  }
  if (scope.client?.access === "read-only") return readOnlyDenial;
  return callerLimits(scope, readShell).pipe(
    Effect.flatMap((limits) => {
      switch (access.kind) {
        case "environment":
          return limits.runtimeMode === "full-access" && limits.interactionMode === "default"
            ? Effect.void
            : deny(
                "capability_denied",
                "Changing projects or environment settings needs a full-access/default caller.",
              );
        case "start":
          return Effect.forEach(
            access.modes(input),
            (requested) =>
              modesWithin(
                limits,
                {
                  runtimeMode: isRuntimeMode(requested.runtimeMode)
                    ? requested.runtimeMode
                    : limits.runtimeMode,
                  interactionMode: isInteractionMode(requested.interactionMode)
                    ? requested.interactionMode
                    : limits.interactionMode,
                },
                "The new thread's",
              ),
            { discard: true },
          );
        case "write":
          return Effect.forEach(
            access.threads(input),
            (threadId) =>
              // The caller's own thread always runs within its own modes. A
              // missing target is the tool's to report.
              typeof threadId !== "string" || threadId === scope.thread?.threadId
                ? Effect.void
                : readShell(threadId as ThreadId).pipe(
                    Effect.flatMap((target) =>
                      target === undefined || target.deletedAt !== null
                        ? Effect.void
                        : modesWithin(limits, target, "That thread's"),
                    ),
                  ),
            { discard: true },
          );
      }
    }),
  );
};

const denialResult = (denial: AccessDenial) =>
  new McpSchema.CallToolResult({
    isError: true,
    structuredContent: { _tag: "OrchestratorMcpFailure", ...denial },
    content: [{ type: "text", text: denial.message }],
  });

/**
 * The MCP server as tool registration sees it: each tool's access from
 * `TOOL_ACCESS` is checked before its handler runs, and a tool missing from
 * the table fails registration.
 */
export const gatedServer = (
  server: McpServer.McpServer["Service"],
  readShell: ReadThreadShell,
): McpServer.McpServer["Service"] => ({
  ...server,
  addTool: (options) => {
    const access = TOOL_ACCESS[options.tool.name];
    if (access === undefined) {
      return Effect.die(new Error(`MCP tool ${options.tool.name} has no entry in TOOL_ACCESS.`));
    }
    return server.addTool({
      ...options,
      handle: (payload) =>
        Effect.serviceOption(McpInvocationContext.McpInvocationContext).pipe(
          Effect.flatMap((scope) =>
            Option.isNone(scope)
              ? options.handle(payload)
              : checkAccess(access, scope.value, payload ?? {}, readShell).pipe(
                  Effect.matchEffect({
                    onFailure: (denial) => Effect.succeed(denialResult(denial)),
                    onSuccess: () => options.handle(payload),
                  }),
                ),
          ),
        ),
    });
  },
});

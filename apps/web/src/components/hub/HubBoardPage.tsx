import {
  HUB_BOARD_COLUMNS,
  projectBoard,
  type EnvironmentId,
  type HubBoardColumn,
  type HubBoardCommand,
  type HubPriority,
  type HubTask,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { randomUUID } from "../../lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Textarea } from "../ui/textarea";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { PRIORITY_OPTIONS } from "./hubFormat";
import { useHubAction } from "./useHubAction";

const COLUMN_LABEL: Record<HubBoardColumn, string> = {
  todo: "Todo",
  in_progress: "In progress",
  ready_for_testing: "Ready for testing",
  done: "Done",
};

/** Per-project kanban. Idle chrome stays still (docs/codr-hub/MOTION.md). */
export function HubBoardPage(props: { readonly projectId: string }) {
  useEscapeToGoBack();
  const { environments } = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const environment =
    connected.find((entry) => entry.environmentId === primaryId) ?? connected[0] ?? null;
  const environmentId = environment?.environmentId ?? null;
  const board = useEnvironmentQuery(
    environmentId
      ? serverEnvironment.hubBoardLive({
          environmentId,
          input: { projectId: props.projectId },
        })
      : null,
  );
  const apply = useHubAction(
    serverEnvironment.hubBoardApply,
    environmentId ?? ("" as EnvironmentId),
    "Could not update the board",
  );
  const [columnFocus, setColumnFocus] = useState<HubBoardColumn>("todo");
  const [draftTitle, setDraftTitle] = useState("");
  const [editing, setEditing] = useState<HubTask | null>(null);

  const projected = useMemo(
    () => (board.data ? projectBoard(board.data.tasks) : null),
    [board.data],
  );

  const run = async (command: HubBoardCommand) => {
    if (!environmentId) return;
    const result = await apply.run(command);
    if (result && command.type === "create") setDraftTitle("");
    if (result && command.type === "update") setEditing(null);
  };

  const header = (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-2">
      <WorkspaceBreadcrumb ariaLabel="Board breadcrumb" className="min-w-0">
        <WorkspaceBreadcrumbItem>
          <Link to="/hub" className="hover:underline">
            Hub
          </Link>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current className="min-w-0 truncate">
          {board.data?.project.name ?? props.projectId}
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          {header}
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {!environmentId ? (
              <p className="text-sm text-muted-foreground">
                Connect an environment to open this board.
              </p>
            ) : board.isPending && !board.data ? (
              <div className="flex flex-col gap-3" aria-busy="true">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-40 w-full" />
              </div>
            ) : board.error && !board.data ? (
              <div role="alert" className="flex flex-col items-start gap-2 text-sm">
                <p>Could not load the board.</p>
                <p className="text-muted-foreground">{board.error}</p>
                <Button size="xs" variant="outline" onClick={board.refresh}>
                  Try again
                </Button>
              </div>
            ) : projected && board.data ? (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                    <span className="text-muted-foreground">New card</span>
                    <Input
                      value={draftTitle}
                      onChange={(event) => setDraftTitle(event.target.value)}
                      placeholder="Title"
                      aria-label="New card title"
                    />
                  </label>
                  <Button
                    size="sm"
                    disabled={apply.busy || draftTitle.trim() === ""}
                    onClick={() =>
                      void run({
                        type: "create",
                        projectId: props.projectId,
                        id: randomUUID(),
                        title: draftTitle.trim(),
                        column: columnFocus,
                      })
                    }
                  >
                    {apply.busy ? "Saving…" : "Add"}
                  </Button>
                </div>

                <div className="@container">
                  <div className="mb-3 @min-[390px]:hidden">
                    <Select
                      value={columnFocus}
                      onValueChange={(next) => next && setColumnFocus(next as HubBoardColumn)}
                    >
                      <SelectTrigger size="default" aria-label="Column">
                        <SelectValue>{COLUMN_LABEL[columnFocus]}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {HUB_BOARD_COLUMNS.map((column) => (
                          <SelectItem key={column} value={column}>
                            {COLUMN_LABEL[column]} ({projected[column].length})
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>

                  <div className="hidden gap-3 @min-[390px]:grid @min-[390px]:grid-cols-4">
                    {HUB_BOARD_COLUMNS.map((column) => (
                      <BoardColumn
                        key={column}
                        column={column}
                        tasks={projected[column]}
                        busy={apply.busy}
                        onMove={(taskId, toColumn) =>
                          void run({
                            type: "move",
                            projectId: props.projectId,
                            taskId,
                            toColumn,
                            beforeTaskId: null,
                            afterTaskId: null,
                          })
                        }
                        onEdit={setEditing}
                        onDelete={(taskId) =>
                          void run({ type: "delete", projectId: props.projectId, taskId })
                        }
                      />
                    ))}
                  </div>

                  <div className="@min-[390px]:hidden">
                    <BoardColumn
                      column={columnFocus}
                      tasks={projected[columnFocus]}
                      busy={apply.busy}
                      onMove={(taskId, toColumn) => {
                        void run({
                          type: "move",
                          projectId: props.projectId,
                          taskId,
                          toColumn,
                          beforeTaskId: null,
                          afterTaskId: null,
                        });
                        setColumnFocus(toColumn);
                      }}
                      onEdit={setEditing}
                      onDelete={(taskId) =>
                        void run({ type: "delete", projectId: props.projectId, taskId })
                      }
                    />
                  </div>
                </div>

                {editing ? (
                  <EditCard
                    task={editing}
                    busy={apply.busy}
                    onClose={() => setEditing(null)}
                    onSave={(patch) =>
                      void run({
                        type: "update",
                        projectId: props.projectId,
                        taskId: editing.id,
                        patch,
                      })
                    }
                  />
                ) : null}
              </div>
            ) : null}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function BoardColumn(props: {
  readonly column: HubBoardColumn;
  readonly tasks: ReadonlyArray<HubTask>;
  readonly busy: boolean;
  readonly onMove: (taskId: string, toColumn: HubBoardColumn) => void;
  readonly onEdit: (task: HubTask) => void;
  readonly onDelete: (taskId: string) => void;
}) {
  return (
    <section aria-labelledby={`hub-col-${props.column}`} className="flex min-w-0 flex-col gap-2">
      <h2 id={`hub-col-${props.column}`} className="text-sm font-medium text-foreground">
        {COLUMN_LABEL[props.column]}
        <span className="ms-1 text-muted-foreground tabular-nums">{props.tasks.length}</span>
      </h2>
      <ol className="flex flex-col gap-2">
        {props.tasks.length === 0 ? (
          <li className="text-sm text-muted-foreground">Empty</li>
        ) : (
          props.tasks.map((task) => (
            <li key={task.id} className="border border-border p-3">
              <button
                type="button"
                className="w-full text-start focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => props.onEdit(task)}
              >
                <span className="font-medium text-foreground">{task.title}</span>
                {task.description.trim() !== "" ? (
                  <span className="mt-1 block text-sm text-muted-foreground line-clamp-3">
                    {task.description}
                  </span>
                ) : null}
              </button>
              <div className="mt-2 flex flex-wrap gap-1">
                {HUB_BOARD_COLUMNS.filter((column) => column !== props.column).map((column) => (
                  <Button
                    key={column}
                    size="xs"
                    variant="ghost-muted"
                    disabled={props.busy}
                    onClick={() => props.onMove(task.id, column)}
                  >
                    {COLUMN_LABEL[column]}
                  </Button>
                ))}
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={props.busy}
                  onClick={() => props.onDelete(task.id)}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))
        )}
      </ol>
    </section>
  );
}

function EditCard(props: {
  readonly task: HubTask;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSave: (patch: {
    title?: string;
    description?: string;
    priority?: HubPriority;
  }) => void;
}) {
  const [title, setTitle] = useState(props.task.title);
  const [description, setDescription] = useState(props.task.description);
  const [priority, setPriority] = useState<HubPriority>(props.task.priority);
  return (
    <div role="dialog" aria-label="Edit card" className="border border-border bg-background p-4">
      <div className="flex flex-col gap-3">
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          aria-label="Card title"
        />
        <Textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          aria-label="Card description"
          rows={4}
        />
        <Select value={priority} onValueChange={(next) => next && setPriority(next as HubPriority)}>
          <SelectTrigger size="default" aria-label="Priority">
            <SelectValue>
              {PRIORITY_OPTIONS.find((option) => option.value === priority)?.label ?? priority}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {PRIORITY_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={props.busy || title.trim() === ""}
            onClick={() =>
              props.onSave({
                title: title.trim(),
                description,
                priority,
              })
            }
          >
            {props.busy ? "Saving…" : "Save"}
          </Button>
          <Button size="sm" variant="ghost-muted" disabled={props.busy} onClick={props.onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

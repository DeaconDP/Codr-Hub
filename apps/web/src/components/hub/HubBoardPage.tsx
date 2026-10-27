import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  HUB_BOARD_COLUMNS,
  projectBoard,
  type EnvironmentId,
  type HubBoardColumn,
  type HubBoardCommand,
  type HubBoardProjection,
  type HubPriority,
  type HubTask,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MoreHorizontalIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { cn, randomUUID } from "../../lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
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
import { isSamePlacement, moveNeighbors } from "./hubBoardMove";
import { PRIORITY_OPTIONS } from "./hubFormat";
import { useHubAction } from "./useHubAction";

const COLUMN_LABEL: Record<HubBoardColumn, string> = {
  todo: "Todo",
  in_progress: "In progress",
  ready_for_testing: "Ready for testing",
  done: "Done",
};

const COLUMN_DROP_PREFIX = "hub-board-col:";

const columnDropId = (column: HubBoardColumn) => `${COLUMN_DROP_PREFIX}${column}`;

const parseColumnDropId = (id: string): HubBoardColumn | null => {
  if (!id.startsWith(COLUMN_DROP_PREFIX)) return null;
  const column = id.slice(COLUMN_DROP_PREFIX.length);
  return (HUB_BOARD_COLUMNS as ReadonlyArray<string>).includes(column)
    ? (column as HubBoardColumn)
    : null;
};

const findTaskColumn = (projected: HubBoardProjection, taskId: string): HubBoardColumn | null => {
  for (const column of HUB_BOARD_COLUMNS) {
    if (projected[column].some((task) => task.id === taskId)) return column;
  }
  return null;
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const run = async (command: HubBoardCommand) => {
    if (!environmentId) return;
    const result = await apply.run(command);
    if (result && command.type === "create") setDraftTitle("");
    if (result && command.type === "update") setEditing(null);
  };

  const placeTask = (
    taskId: string,
    toColumn: HubBoardColumn,
    neighbors: { beforeTaskId: string | null; afterTaskId: string | null },
  ) => {
    if (!projected) return;
    if (
      findTaskColumn(projected, taskId) === toColumn &&
      isSamePlacement({
        columnTasks: projected[toColumn],
        taskId,
        beforeTaskId: neighbors.beforeTaskId,
        afterTaskId: neighbors.afterTaskId,
      })
    ) {
      return;
    }
    void run({
      type: "move",
      projectId: props.projectId,
      taskId,
      toColumn,
      beforeTaskId: neighbors.beforeTaskId,
      afterTaskId: neighbors.afterTaskId,
    });
  };

  const moveToColumn = (taskId: string, toColumn: HubBoardColumn) => {
    if (!projected) return;
    const neighbors = moveNeighbors({
      destTasks: projected[toColumn],
      activeId: taskId,
      overTaskId: null,
    });
    placeTask(taskId, toColumn, neighbors);
    setColumnFocus(toColumn);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    if (apply.busy || !projected || event.over === null) return;
    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    if (activeId === overId) return;

    const fromColumn = findTaskColumn(projected, activeId);
    if (fromColumn === null) return;

    const overColumn = parseColumnDropId(overId);
    const toColumn = overColumn ?? findTaskColumn(projected, overId);
    if (toColumn === null) return;

    const neighbors = moveNeighbors({
      destTasks: projected[toColumn],
      activeId,
      overTaskId: overColumn === null ? overId : null,
    });
    placeTask(activeId, toColumn, neighbors);
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
                      disabled={apply.busy}
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

                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCorners}
                    onDragEnd={handleDragEnd}
                  >
                    <div className="flex flex-col gap-3 @min-[390px]:grid @min-[390px]:grid-cols-4">
                      {HUB_BOARD_COLUMNS.map((column) => (
                        <BoardColumn
                          key={column}
                          column={column}
                          tasks={projected[column]}
                          busy={apply.busy}
                          className={
                            column === columnFocus ? undefined : "hidden @min-[390px]:flex"
                          }
                          onMoveToColumn={moveToColumn}
                          onEdit={setEditing}
                          onDelete={(taskId) =>
                            void run({ type: "delete", projectId: props.projectId, taskId })
                          }
                        />
                      ))}
                    </div>
                  </DndContext>
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
  readonly className?: string;
  readonly onMoveToColumn: (taskId: string, toColumn: HubBoardColumn) => void;
  readonly onEdit: (task: HubTask) => void;
  readonly onDelete: (taskId: string) => void;
}) {
  const droppable = useDroppable({ id: columnDropId(props.column) });
  const itemIds = props.tasks.map((task) => task.id);

  return (
    <section
      ref={droppable.setNodeRef}
      aria-labelledby={`hub-col-${props.column}`}
      className={cn("flex min-w-0 flex-col gap-2 rounded-md p-1", props.className)}
    >
      <h2 id={`hub-col-${props.column}`} className="px-1 text-sm font-medium text-foreground">
        {COLUMN_LABEL[props.column]}
        <span className="ms-1 text-muted-foreground tabular-nums">{props.tasks.length}</span>
      </h2>
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        <ol className="flex min-h-16 flex-col gap-2">
          {props.tasks.length === 0 ? (
            <li className="px-1 py-3 text-sm text-muted-foreground">Empty</li>
          ) : (
            props.tasks.map((task) => (
              <SortableCard
                key={task.id}
                task={task}
                column={props.column}
                busy={props.busy}
                onMoveToColumn={props.onMoveToColumn}
                onEdit={props.onEdit}
                onDelete={props.onDelete}
              />
            ))
          )}
        </ol>
      </SortableContext>
    </section>
  );
}

function SortableCard(props: {
  readonly task: HubTask;
  readonly column: HubBoardColumn;
  readonly busy: boolean;
  readonly onMoveToColumn: (taskId: string, toColumn: HubBoardColumn) => void;
  readonly onEdit: (task: HubTask) => void;
  readonly onDelete: (taskId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: props.task.id,
    disabled: props.busy,
    animateLayoutChanges: () => false,
  });

  return (
    <li
      ref={setNodeRef}
      style={isDragging ? { transform: CSS.Translate.toString(transform), zIndex: 10 } : undefined}
      className={cn(
        "border border-border/60 bg-background px-3 py-2.5",
        isDragging && "relative border-border shadow-md opacity-95",
      )}
    >
      <div className="flex items-start gap-1">
        <button
          type="button"
          className={cn(
            "min-h-11 min-w-0 flex-1 cursor-grab touch-none py-1 text-start active:cursor-grabbing",
            "focus-visible:outline-2 focus-visible:outline-ring",
            props.busy && "cursor-default",
          )}
          disabled={props.busy}
          onClick={() => props.onEdit(props.task)}
          {...attributes}
          {...listeners}
        >
          <span className="font-medium text-foreground">{props.task.title}</span>
          {props.task.description.trim() !== "" ? (
            <span className="mt-1 block text-sm text-muted-foreground line-clamp-3">
              {props.task.description}
            </span>
          ) : null}
        </button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xl"
                variant="ghost-muted"
                className="shrink-0"
                disabled={props.busy}
                aria-label={`Actions for ${props.task.title}`}
              />
            }
          >
            <MoreHorizontalIcon className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            {HUB_BOARD_COLUMNS.filter((column) => column !== props.column).map((column) => (
              <MenuItem
                key={column}
                density="touch"
                disabled={props.busy}
                onClick={() => props.onMoveToColumn(props.task.id, column)}
              >
                Move to {COLUMN_LABEL[column]}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem
              density="touch"
              variant="destructive"
              disabled={props.busy}
              onClick={() => props.onDelete(props.task.id)}
            >
              Delete
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </li>
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

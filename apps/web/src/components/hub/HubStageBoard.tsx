import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  type EnvironmentId,
  type HubBoardColumn,
  type HubMergedProjectView,
  type HubSdlcMode,
  type HubSnapshot,
  type HubTask,
} from "@t3tools/contracts";
import { labelOf } from "@t3tools/client-runtime/codrHub/hubFormat";
import {
  groupByStageColumn,
  stageCardGlance,
  stageCardTasks,
  stageColumns,
  stageForDrop,
  taskToggleCommand,
  type StageColumn,
} from "@t3tools/client-runtime/codrHub/stageBoardModel";
import { Link } from "@tanstack/react-router";
import { MoreHorizontalIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn, randomUUID } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { HubRunningBadge } from "./HubRunningBadge";
import { useHubAction } from "./useHubAction";

const COLUMN_DROP_PREFIX = "hub-stage-col:";

// Static strings so Tailwind sees every class; six columns need a wider container.
const LAYOUT: Record<HubSdlcMode, { grid: string; hidden: string; picker: string }> = {
  three: {
    grid: "@min-[40rem]:grid @min-[40rem]:grid-cols-3",
    hidden: "hidden @min-[40rem]:flex",
    picker: "@min-[40rem]:hidden",
  },
  six: {
    grid: "@min-[64rem]:grid @min-[64rem]:grid-cols-6",
    hidden: "hidden @min-[64rem]:flex",
    picker: "@min-[64rem]:hidden",
  },
};

const TASK_COLUMN_LABEL: Partial<Record<HubBoardColumn, string>> = {
  in_progress: "In progress",
  ready_for_testing: "Ready for testing",
};

/** Projects as cards in SDLC stage columns, in rank order; each card holds its board tasks. */
export function HubStageBoard(props: {
  readonly environmentId: EnvironmentId;
  readonly rows: ReadonlyArray<HubMergedProjectView>;
  readonly snapshot: HubSnapshot;
  readonly selectedNodeName: string;
  readonly onEdit: (view: HubMergedProjectView) => void;
}) {
  const mode = props.snapshot.settings.sdlcMode;
  const columns = stageColumns(mode);
  const grouped = groupByStageColumn(props.rows, columns);
  const [focus, setFocus] = useState(columns[0]?.id ?? "");
  const focusId = columns.some((column) => column.id === focus) ? focus : (columns[0]?.id ?? "");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const upsert = useHubAction(
    serverEnvironment.hubUpsertProject,
    props.environmentId,
    "Could not move the project",
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const layout = LAYOUT[mode];

  const moveTo = (view: HubMergedProjectView, column: StageColumn) => {
    const stage = stageForDrop(view.project.stage, column);
    if (stage !== null) void upsert.run({ id: view.project.id, stage });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    if (upsert.busy || event.over === null) return;
    const overId = String(event.over.id);
    const column = columns.find((entry) => `${COLUMN_DROP_PREFIX}${entry.id}` === overId);
    const view = props.rows.find((entry) => entry.project.id === String(event.active.id));
    if (column && view) moveTo(view, column);
  };

  const toggle = (projectId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(projectId)) next.add(projectId);
      return next;
    });

  return (
    <div className="@container">
      <div className={cn("mb-3", layout.picker)}>
        <Select value={focusId} onValueChange={(next) => next && setFocus(next)}>
          <SelectTrigger size="default" aria-label="Stage">
            <SelectValue>{labelOf(columnOptions(columns), focusId)}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {columns.map((column) => (
              <SelectItem key={column.id} value={column.id}>
                {column.label} ({grouped.get(column.id)?.length ?? 0})
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
        <div className={cn("flex flex-col gap-3", layout.grid)}>
          {columns.map((column) => (
            <StageColumnView
              key={column.id}
              column={column}
              className={column.id === focusId ? undefined : layout.hidden}
            >
              {(grouped.get(column.id) ?? []).map((view) => (
                <ProjectCard
                  key={view.project.id}
                  view={view}
                  environmentId={props.environmentId}
                  snapshot={props.snapshot}
                  selectedNodeName={props.selectedNodeName}
                  columns={columns}
                  busy={upsert.busy}
                  expanded={expanded.has(view.project.id)}
                  onToggle={() => toggle(view.project.id)}
                  onEdit={() => props.onEdit(view)}
                  onMove={(target) => moveTo(view, target)}
                />
              ))}
            </StageColumnView>
          ))}
        </div>
      </DndContext>
    </div>
  );
}

const columnOptions = (columns: ReadonlyArray<StageColumn>) =>
  columns.map((column) => ({ value: column.id, label: column.label }));

function StageColumnView(props: {
  readonly column: StageColumn;
  readonly className?: string | undefined;
  readonly children: ReadonlyArray<ReactNode>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_DROP_PREFIX}${props.column.id}` });
  return (
    <section
      ref={setNodeRef}
      aria-labelledby={`hub-stage-${props.column.id}`}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-md p-1",
        isOver && "bg-accent/40",
        props.className,
      )}
    >
      <h3 id={`hub-stage-${props.column.id}`} className="px-1 text-sm font-medium text-foreground">
        {props.column.label}
        <span className="ms-1 text-muted-foreground tabular-nums">{props.children.length}</span>
      </h3>
      <ol className="flex min-h-16 flex-col gap-2">
        {props.children.length === 0 ? (
          <li className="px-1 py-3 text-sm text-muted-foreground">Empty</li>
        ) : (
          props.children
        )}
      </ol>
    </section>
  );
}

function ProjectCard(props: {
  readonly view: HubMergedProjectView;
  readonly environmentId: EnvironmentId;
  readonly snapshot: HubSnapshot;
  readonly selectedNodeName: string;
  readonly columns: ReadonlyArray<StageColumn>;
  readonly busy: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onEdit: () => void;
  readonly onMove: (column: StageColumn) => void;
}) {
  const { project } = props.view;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: project.id,
    disabled: props.busy,
  });
  const selected = props.view.nodes.find((node) => node.nodeName === props.selectedNodeName);
  const running = selected?.running ?? 0;
  const counts = props.snapshot.taskCounts?.[project.id];
  const glance = stageCardGlance(props.view, props.snapshot.strategy);

  return (
    <li
      ref={setNodeRef}
      style={isDragging ? { transform: CSS.Translate.toString(transform), zIndex: 10 } : undefined}
      className={cn(
        "border border-border/60 bg-background",
        isDragging && "relative border-border shadow-md opacity-95",
      )}
    >
      <div className="flex items-start gap-1 px-3 pt-2">
        <button
          type="button"
          className={cn(
            "min-h-11 min-w-0 flex-1 cursor-grab touch-none py-1 text-start active:cursor-grabbing",
            "focus-visible:outline-2 focus-visible:outline-ring",
            props.busy && "cursor-default",
          )}
          onClick={props.onEdit}
          {...attributes}
          {...listeners}
        >
          <span className="flex items-center gap-1.5 font-medium text-foreground">
            <span className="truncate">{project.name}</span>
            {running > 0 ? <HubRunningBadge count={running} /> : null}
          </span>
          {glance ? (
            <span className="mt-0.5 block text-sm text-muted-foreground">{glance}</span>
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
                aria-label={`Move ${project.name}`}
              />
            }
          >
            <MoreHorizontalIcon className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            {props.columns
              .filter((column) => !column.stages.includes(project.stage))
              .map((column) => (
                <MenuItem
                  key={column.id}
                  density="touch"
                  disabled={props.busy}
                  onClick={() => props.onMove(column)}
                >
                  Move to {column.label}
                </MenuItem>
              ))}
          </MenuPopup>
        </Menu>
      </div>
      <div className="px-2 pb-1">
        <Button
          size="xs"
          variant="ghost-muted"
          aria-expanded={props.expanded}
          onClick={props.onToggle}
        >
          {counts ? `${counts.done}/${counts.total} tasks` : "Tasks"}
        </Button>
      </div>
      {props.expanded ? (
        <ProjectTasks environmentId={props.environmentId} projectId={project.id} />
      ) : null}
    </li>
  );
}

/** Subscribes to one project's board only while its card is open. */
function ProjectTasks(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
}) {
  const board = useEnvironmentQuery(
    serverEnvironment.hubBoardLive({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const apply = useHubAction(
    serverEnvironment.hubBoardApply,
    props.environmentId,
    "Could not update the task",
  );
  const [draft, setDraft] = useState("");

  if (!board.data) {
    return board.error ? (
      <p role="alert" className="px-3 pb-3 text-sm text-muted-foreground">
        {board.error}
      </p>
    ) : (
      <div className="px-3 pb-3" aria-busy="true">
        <Skeleton className="h-6 w-full" />
      </div>
    );
  }
  const allTasks = board.data.tasks;
  const tasks = stageCardTasks(allTasks);
  const setDone = (task: HubTask, done: boolean) =>
    void apply.run(taskToggleCommand(allTasks, task, done));

  const add = async () => {
    const title = draft.trim();
    if (title === "") return;
    const result = await apply.run({
      type: "create",
      projectId: props.projectId,
      id: randomUUID(),
      title,
      column: "todo",
    });
    if (result) setDraft("");
  };

  return (
    <div className="flex flex-col gap-1 border-t border-border/60 px-3 py-2">
      {tasks.length > 0 ? (
        <ul className="flex flex-col">
          {tasks.map((task) => (
            <li key={task.id}>
              <label className="flex min-h-9 items-start gap-2 py-1 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={task.column === "done"}
                  disabled={apply.busy}
                  onCheckedChange={(checked) => setDone(task, checked)}
                />
                <span
                  className={cn(
                    "min-w-0 flex-1",
                    task.column === "done" && "text-muted-foreground line-through",
                  )}
                >
                  {task.title}
                  {TASK_COLUMN_LABEL[task.column] ? (
                    <span className="ms-1.5 text-muted-foreground no-underline">
                      {TASK_COLUMN_LABEL[task.column]}
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <Input
          size="sm"
          className="min-w-0 flex-1"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add a task"
          aria-label="New task"
          disabled={apply.busy}
        />
        <Button
          size="xs"
          variant="ghost-muted"
          render={
            <Link to="/hub/projects/$projectId/board" params={{ projectId: props.projectId }} />
          }
        >
          Board
        </Button>
      </form>
    </div>
  );
}

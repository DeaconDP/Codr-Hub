import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectIconColor } from "@t3tools/contracts";
import {
  CheckIcon,
  EllipsisIcon,
  FolderPlusIcon,
  GripVerticalIcon,
  MessageSquareDashedIcon,
  PaletteIcon,
  PencilIcon,
  StarIcon,
  TagIcon,
} from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { PROJECT_ICON_COLORS, projectIconColorClassName } from "~/projectIconColors";
import type { SidebarProjectPickerEntry } from "~/sidebarProjectGrouping";
import {
  useEnvironmentMachines,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  allPickerTags,
  linkPickerRows,
  machineColor,
  parseTags,
  pickerSections,
  pickerWriteFor,
  planPickerReorder,
  rowMatches,
  rowTags,
  type PickerRow,
} from "./projectPickerModel";

type Row = PickerRow<SidebarProjectPickerEntry["group"]>;

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The request failed.",
    }),
  );
}

const HUB_UNAVAILABLE = "Connect a machine running Codr-Hub that has this project checked out.";

/**
 * Codr-Hub: the new-thread project picker. Rows carry favourites, tags and a
 * manual order from the portfolio, and a colour-coded icon per machine.
 */
export function HubProjectPicker(props: {
  readonly entries: ReadonlyArray<SidebarProjectPickerEntry>;
  readonly activeProjectKey: string;
  readonly noProjectActive: boolean;
  readonly triggerLabel: string;
  readonly onSelect: (entry: SidebarProjectPickerEntry) => void;
  readonly onNoProject: (() => void) | null;
  readonly onAddProject: () => void;
}) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const machineKinds = useEnvironmentMachines();
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const connectedKey = JSON.stringify(connected.map((environment) => environment.environmentId));
  const hub = useAtomValue(
    connected.length === 0
      ? serverEnvironment.hubMergedProjectsEmpty
      : serverEnvironment.hubMergedProjects(connectedKey),
  );
  const nodeNames = hub.nodeNameByEnvironmentId;
  const nodeColors = hub.anySnapshot?.settings.nodeColors ?? {};
  const upsertProject = useAtomCommand(serverEnvironment.hubUpsertProject, {
    reportFailure: false,
  });
  const upsertProjects = useAtomCommand(serverEnvironment.hubUpsertProjects, {
    reportFailure: false,
  });
  const updateHubSettings = useAtomCommand(serverEnvironment.hubUpdateSettings, {
    reportFailure: false,
  });
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ key: string; text: string } | null>(null);
  const [tagging, setTagging] = useState<Row | null>(null);
  const [coloring, setColoring] = useState(false);
  // Order shown while a reorder write is in flight, so rows do not snap back.
  const [pendingOrder, setPendingOrder] = useState<ReadonlyArray<string> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const entryByKey = useMemo(
    () => new Map(props.entries.map((entry) => [entry.group.projectKey, entry])),
    [props.entries],
  );
  const rows = useMemo(
    () =>
      linkPickerRows(
        props.entries.map((entry) => entry.group),
        hub.projects,
        nodeNames,
      ),
    [hub.projects, nodeNames, props.entries],
  );
  const sections = useMemo(() => {
    const { favorites, others } = pickerSections(rows);
    if (pendingOrder === null) return { favorites, others };
    const rank = new Map(pendingOrder.map((key, index) => [key, index]));
    const byPending = (a: Row, b: Row) =>
      (rank.get(a.group.projectKey) ?? Infinity) - (rank.get(b.group.projectKey) ?? Infinity);
    return { favorites: favorites.sort(byPending), others: others.sort(byPending) };
  }, [pendingOrder, rows]);
  const tags = useMemo(() => allPickerTags(rows), [rows]);
  const filtering = query.trim() !== "" || tag !== null;
  const visible = useMemo(
    () => ({
      favorites: sections.favorites.filter((row) => rowMatches(row, query, tag)),
      others: sections.others.filter((row) => rowMatches(row, query, tag)),
    }),
    [query, sections, tag],
  );
  const flat = [...visible.favorites, ...visible.others];
  const active = flat.find((row) => row.group.projectKey === activeKey) ?? flat[0] ?? null;

  const environmentById = new Map(environments.map((entry) => [entry.environmentId, entry]));
  const machinesFor = (row: Row) => {
    const seen = new Set<EnvironmentId>();
    return row.group.memberProjects
      .filter((member) => !seen.has(member.environmentId) && seen.add(member.environmentId))
      .map((member) => {
        const label =
          nodeNames.get(member.environmentId) ??
          environmentById.get(member.environmentId)?.label ??
          member.environmentLabel ??
          "Remote";
        return {
          environmentId: member.environmentId,
          label,
          color: machineColor(label, nodeColors),
          kind: machineKinds.get(member.environmentId) ?? "server",
        };
      })
      .sort(
        (a, b) =>
          Number(b.environmentId === primaryEnvironmentId) -
            Number(a.environmentId === primaryEnvironmentId) || a.label.localeCompare(b.label),
      );
  };

  const writeRow = async (
    row: Row,
    patch: Parameters<typeof pickerWriteFor>[1],
    failureTitle: string,
  ) => {
    const write = pickerWriteFor(row, patch, nodeNames, primaryEnvironmentId);
    if (write === null) {
      toastManager.add({ type: "warning", title: failureTitle, description: HUB_UNAVAILABLE });
      return false;
    }
    const result = await upsertProject(write);
    reportFailure(failureTitle, result);
    return result._tag === "Success";
  };

  const toggleFavorite = (row: Row) =>
    void writeRow(
      row,
      { favorite: !(row.hub?.project.favorite ?? false) },
      "Could not update favourite",
    );

  const reorder = async (section: ReadonlyArray<Row>, fromIndex: number, toIndex: number) => {
    const batches = planPickerReorder(section, fromIndex, toIndex, nodeNames, primaryEnvironmentId);
    if (batches === null) {
      toastManager.add({
        type: "warning",
        title: "Could not save the order",
        description: HUB_UNAVAILABLE,
      });
      return;
    }
    if (batches.size === 0) return;
    const keys = section.map((row) => row.group.projectKey);
    const [moved] = keys.splice(fromIndex, 1);
    keys.splice(toIndex, 0, moved!);
    setPendingOrder(keys);
    for (const [environmentId, projects] of batches) {
      const result = await upsertProjects({ environmentId, input: { projects } });
      reportFailure("Could not save the order", result);
      if (result._tag !== "Success") break;
    }
    setPendingOrder(null);
  };

  // A rename changes the T3 project on every machine it lives on, and the
  // linked portfolio project, so the picker, sidebar and Hub agree.
  const commitRename = async (row: Row, text: string) => {
    setRenaming(null);
    const title = text.trim();
    if (title === "" || title === row.group.displayName) return;
    for (const member of row.group.memberProjects) {
      const result = await updateProject({
        environmentId: member.environmentId,
        input: { projectId: member.id, title },
      });
      if (result._tag !== "Success") {
        reportFailure(
          row.group.memberProjects.length > 1
            ? `Could not rename on ${member.environmentLabel ?? "this machine"}`
            : "Could not rename project",
          result,
        );
        return;
      }
    }
    if (row.hub) await writeRow(row, { name: title }, "Could not rename the Hub project");
  };

  const select = (row: Row) => {
    const entry = entryByKey.get(row.group.projectKey);
    if (!entry) return;
    setOpen(false);
    if (row.group.projectKey !== props.activeProjectKey) props.onSelect(entry);
  };

  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (active === null) return;
    const index = flat.indexOf(active);
    if (event.key === "Enter") {
      event.preventDefault();
      select(active);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    if (event.altKey && !filtering) {
      const section = active.hub?.project.favorite ? sections.favorites : sections.others;
      const from = section.indexOf(active);
      const to = from + step;
      if (to >= 0 && to < section.length) void reorder(section, from, to);
      return;
    }
    const next = flat[Math.min(flat.length - 1, Math.max(0, index + step))];
    if (next) setActiveKey(next.group.projectKey);
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const onDragEnd = (section: ReadonlyArray<Row>) => (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    const from = section.findIndex((row) => row.group.projectKey === event.active.id);
    const to = section.findIndex((row) => row.group.projectKey === event.over?.id);
    if (from >= 0 && to >= 0) void reorder(section, from, to);
  };

  const renderSection = (title: string, all: ReadonlyArray<Row>, shown: ReadonlyArray<Row>) =>
    shown.length === 0 ? null : (
      <section aria-label={title} className="py-1">
        <h3 className="px-2 pb-1 font-medium text-muted-foreground text-xs">{title}</h3>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
          onDragEnd={onDragEnd(all)}
        >
          <SortableContext
            items={shown.map((row) => row.group.projectKey)}
            strategy={verticalListSortingStrategy}
            disabled={filtering}
          >
            <ul>
              {shown.map((row) => (
                <PickerRowItem
                  key={row.group.projectKey}
                  row={row}
                  sortable={!filtering}
                  isActive={row === active}
                  isSelected={
                    !props.noProjectActive && row.group.projectKey === props.activeProjectKey
                  }
                  machines={machinesFor(row)}
                  renaming={renaming?.key === row.group.projectKey ? renaming.text : null}
                  onHover={() => setActiveKey(row.group.projectKey)}
                  onSelect={() => select(row)}
                  onToggleFavorite={() => toggleFavorite(row)}
                  onStartRename={() =>
                    setRenaming({ key: row.group.projectKey, text: row.group.displayName })
                  }
                  onRenameChange={(text) => setRenaming({ key: row.group.projectKey, text })}
                  onCommitRename={(text) => void commitRename(row, text)}
                  onCancelRename={() => setRenaming(null)}
                  onEditTags={() => setTagging(row)}
                  onEditColors={() => setColoring(true)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      </section>
    );

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setQuery("");
            setRenaming(null);
          }
        }}
      >
        <PopoverTrigger
          render={<InlineButton tone="picker" />}
          data-draft-project-trigger=""
          className="pointer-events-auto max-w-64 align-baseline"
        >
          <span className="min-w-0 truncate">{props.triggerLabel}</span>
        </PopoverTrigger>
        <PopoverPopup width="lg" padding="compact" align="center" initialFocus={inputRef}>
          <div className="flex flex-col gap-2">
            <Input
              ref={inputRef}
              size="sm"
              value={query}
              placeholder="Find a project or tag"
              aria-label="Find a project or tag"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onFilterKeyDown}
            />
            {tags.length > 0 ? (
              <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by tag">
                {tags.map((entry) => (
                  <Button
                    key={entry}
                    size="xs"
                    variant={tag === entry ? "secondary" : "ghost-muted"}
                    aria-pressed={tag === entry}
                    onClick={() => setTag(tag === entry ? null : entry)}
                  >
                    {entry}
                  </Button>
                ))}
              </div>
            ) : null}
            <div className="-mx-1 max-h-80 overflow-y-auto">
              {renderSection("Favourites", sections.favorites, visible.favorites)}
              {renderSection(
                sections.favorites.length > 0 ? "Projects" : "All projects",
                sections.others,
                visible.others,
              )}
              {flat.length === 0 ? (
                <p className="px-2 py-3 text-muted-foreground text-sm">No matching projects.</p>
              ) : null}
            </div>
            <div className="-mx-1 flex flex-col border-t pt-1">
              {props.onNoProject ? (
                <FooterButton
                  icon={
                    <MessageSquareDashedIcon
                      className={`size-4 ${projectIconColorClassName("gray")}`}
                    />
                  }
                  onClick={() => {
                    setOpen(false);
                    props.onNoProject?.();
                  }}
                >
                  No project
                  {props.noProjectActive ? <CheckIcon className="ml-auto size-4" /> : null}
                </FooterButton>
              ) : null}
              <FooterButton
                icon={<FolderPlusIcon className="size-4" />}
                onClick={() => {
                  setOpen(false);
                  props.onAddProject();
                }}
              >
                Add project
              </FooterButton>
              <FooterButton
                icon={<PaletteIcon className="size-4" />}
                onClick={() => setColoring(true)}
              >
                Machine colours
              </FooterButton>
            </div>
            {!filtering && flat.length > 1 ? (
              <p className="px-1 text-muted-foreground text-xs">
                Drag to reorder, or Alt+↑/↓ on the highlighted project.
              </p>
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
      {tagging ? (
        <TagsDialog
          row={tagging}
          knownTags={tags}
          onClose={() => setTagging(null)}
          onSave={async (next) => {
            if (await writeRow(tagging, { tags: next }, "Could not save tags")) setTagging(null);
          }}
        />
      ) : null}
      {coloring ? (
        <MachineColorsDialog
          machines={connected.map((environment) => {
            const label = nodeNames.get(environment.environmentId) ?? environment.label;
            return {
              environmentId: environment.environmentId,
              label,
              color: machineColor(label, nodeColors),
              custom: nodeColors[label] !== undefined,
              hasHub: nodeNames.has(environment.environmentId),
              kind: machineKinds.get(environment.environmentId) ?? "server",
            };
          })}
          onClose={() => setColoring(false)}
          onPick={async (nodeName, color) => {
            const environmentId =
              [...nodeNames.keys()].find((id) => id === primaryEnvironmentId) ??
              [...nodeNames.keys()][0];
            if (environmentId === undefined) return;
            const result = await updateHubSettings({
              environmentId,
              input: { nodeColors: { [nodeName]: color } },
            });
            reportFailure("Could not save the machine colour", result);
          }}
        />
      ) : null}
    </>
  );
}

function FooterButton(props: {
  readonly icon: ReactNode;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-hidden"
    >
      {props.icon}
      {props.children}
    </button>
  );
}

type Machine = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly color: ProjectIconColor;
  readonly kind: Parameters<typeof EnvironmentMachineIcon>[0]["kind"];
};

function PickerRowItem(props: {
  readonly row: Row;
  readonly sortable: boolean;
  readonly isActive: boolean;
  readonly isSelected: boolean;
  readonly machines: ReadonlyArray<Machine>;
  readonly renaming: string | null;
  readonly onHover: () => void;
  readonly onSelect: () => void;
  readonly onToggleFavorite: () => void;
  readonly onStartRename: () => void;
  readonly onRenameChange: (text: string) => void;
  readonly onCommitRename: (text: string) => void;
  readonly onCancelRename: () => void;
  readonly onEditTags: () => void;
  readonly onEditColors: () => void;
}) {
  const { row } = props;
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition, isDragging } =
    useSortable({ id: row.group.projectKey, disabled: !props.sortable });
  const favorite = row.hub?.project.favorite ?? false;
  // Enter commits and unmounts the field, which can also fire blur.
  const renameDoneRef = useRef(false);
  const commitOnce = () => {
    if (renameDoneRef.current) return;
    renameDoneRef.current = true;
    props.onCommitRename(props.renaming ?? "");
  };
  const tags = rowTags(row);
  const machinesLabel = `On ${props.machines.map((machine) => machine.label).join(", ")}`;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onPointerEnter={props.onHover}
      data-active={props.isActive || undefined}
      className={`group/row flex h-8 items-center gap-1 rounded-md pr-1 data-active:bg-accent ${isDragging ? "relative z-10 bg-accent shadow-sm" : ""}`}
    >
      <span
        ref={setActivatorNodeRef}
        {...(props.sortable ? listeners : {})}
        aria-hidden="true"
        className={`flex h-full w-4 shrink-0 touch-none items-center justify-center text-muted-foreground/60 ${props.sortable ? "cursor-grab opacity-0 group-hover/row:opacity-100 pointer-coarse:opacity-100" : "invisible"}`}
      >
        <GripVerticalIcon className="size-3.5" />
      </span>
      {props.renaming !== null ? (
        <input
          autoFocus
          aria-label="Project name"
          value={props.renaming}
          onChange={(event) => props.onRenameChange(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") commitOnce();
            if (event.key === "Escape") {
              event.preventDefault();
              renameDoneRef.current = true;
              props.onCancelRename();
            }
          }}
          onFocus={() => {
            renameDoneRef.current = false;
          }}
          onBlur={commitOnce}
          className="h-7 min-w-0 flex-1 rounded-sm border border-input bg-background px-1.5 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : (
        <button
          type="button"
          onClick={props.onSelect}
          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left text-sm focus-visible:outline-hidden"
        >
          <ProjectFavicon project={row.group} className="size-4 shrink-0" />
          <span className="min-w-0 truncate">{row.group.displayName}</span>
          {tags.slice(0, 2).map((entry) => (
            <Badge key={entry} size="sm" variant="outline">
              {entry}
            </Badge>
          ))}
          {tags.length > 2 ? (
            <span className="shrink-0 text-muted-foreground text-xs">+{tags.length - 2}</span>
          ) : null}
          {props.isSelected ? <CheckIcon className="ml-auto size-4 shrink-0" /> : null}
        </button>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="img"
              aria-label={machinesLabel}
              className="flex shrink-0 items-center gap-0.5"
            />
          }
        >
          {props.machines.map((machine) => (
            <EnvironmentMachineIcon
              key={machine.environmentId}
              aria-hidden
              kind={machine.kind}
              className={`size-3.5 ${projectIconColorClassName(machine.color)}`}
            />
          ))}
        </TooltipTrigger>
        <TooltipPopup side="top">{machinesLabel}</TooltipPopup>
      </Tooltip>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={favorite ? "Remove from favourites" : "Add to favourites"}
        aria-pressed={favorite}
        onClick={props.onToggleFavorite}
      >
        <StarIcon className={favorite ? "fill-warning text-warning" : undefined} />
      </Button>
      <Menu>
        <MenuTrigger
          render={<Button size="icon-xs" variant="ghost-muted" />}
          aria-label={`More for ${row.group.displayName}`}
        >
          <EllipsisIcon />
        </MenuTrigger>
        {/* Rename focuses its own field; returning focus to this trigger would blur it. */}
        <MenuPopup align="end" finalFocus={false}>
          <MenuItem onClick={props.onStartRename}>
            <PencilIcon />
            Rename
          </MenuItem>
          <MenuItem onClick={props.onEditTags}>
            <TagIcon />
            Edit tags
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={props.onEditColors}>
            <PaletteIcon />
            Machine colours
          </MenuItem>
        </MenuPopup>
      </Menu>
    </li>
  );
}

function TagsDialog(props: {
  readonly row: Row;
  readonly knownTags: ReadonlyArray<string>;
  readonly onClose: () => void;
  readonly onSave: (tags: string[]) => Promise<void>;
}) {
  const [text, setText] = useState(rowTags(props.row).join(", "));
  const [busy, setBusy] = useState(false);
  const current = parseTags(text);
  const toggle = (entry: string) =>
    setText(
      (current.includes(entry) ? current.filter((tag) => tag !== entry) : [...current, entry]).join(
        ", ",
      ),
    );
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            void props.onSave(current).finally(() => setBusy(false));
          }}
        >
          <DialogHeader>
            <DialogTitle>Tags for {props.row.group.displayName}</DialogTitle>
            <DialogDescription>
              Separate tags with commas. Tags sync to every machine through the portfolio.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <Input
                autoFocus
                aria-label="Tags"
                value={text}
                placeholder="client, web, ops"
                onChange={(event) => setText(event.target.value)}
              />
              {props.knownTags.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {props.knownTags.map((entry) => (
                    <Button
                      key={entry}
                      type="button"
                      size="xs"
                      variant={current.includes(entry) ? "secondary" : "ghost-muted"}
                      aria-pressed={current.includes(entry)}
                      onClick={() => toggle(entry)}
                    >
                      {entry}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Save tags
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function MachineColorsDialog(props: {
  readonly machines: ReadonlyArray<
    Machine & { readonly custom: boolean; readonly hasHub: boolean }
  >;
  readonly onClose: () => void;
  readonly onPick: (nodeName: string, color: ProjectIconColor | null) => Promise<void>;
}) {
  const canSave = props.machines.some((machine) => machine.hasHub);
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Machine colours</DialogTitle>
          <DialogDescription>
            Each machine gets a colour automatically. Pick one to change it on every device.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {props.machines.length === 0 ? (
            <p className="text-muted-foreground text-sm">No machines are connected.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {props.machines.map((machine) => (
                <li key={machine.environmentId} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2 text-sm">
                    <EnvironmentMachineIcon
                      aria-hidden
                      kind={machine.kind}
                      className={`size-4 ${projectIconColorClassName(machine.color)}`}
                    />
                    <span className="min-w-0 truncate font-medium">{machine.label}</span>
                    {machine.custom ? (
                      <span className="ml-auto text-xs">
                        <InlineButton
                          tone="muted"
                          disabled={!canSave}
                          onClick={() => void props.onPick(machine.label, null)}
                        >
                          Use automatic
                        </InlineButton>
                      </span>
                    ) : (
                      <span className="ml-auto text-muted-foreground text-xs">Automatic</span>
                    )}
                  </div>
                  <div
                    role="radiogroup"
                    aria-label={`Colour for ${machine.label}`}
                    className="flex flex-wrap gap-1"
                  >
                    {PROJECT_ICON_COLORS.filter((option) => option.value !== "gray").map(
                      (option) => (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={machine.color === option.value}
                          aria-label={option.label}
                          disabled={!canSave}
                          onClick={() => void props.onPick(machine.label, option.value)}
                          className={`size-5 rounded-full ${option.swatchClassName} ring-offset-2 ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring aria-checked:ring-2 aria-checked:ring-foreground disabled:opacity-50`}
                        />
                      ),
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {canSave ? null : (
            <p className="mt-3 text-muted-foreground text-sm">
              Connect a machine running Codr-Hub to save colours.
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

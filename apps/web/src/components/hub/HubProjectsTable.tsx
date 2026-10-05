import type {
  EnvironmentId,
  HubAutonomy,
  HubPriority,
  HubProjectStatus,
  HubProjectView,
  HubSdlcStage,
  HubSnapshot,
  HubUpsertProjectInput,
} from "@t3tools/contracts";
import { DownloadIcon, FolderXIcon, PlusIcon, StarIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { HubProjectDialog } from "./HubProjectDialog";
import {
  AUTONOMY_OPTIONS,
  FILTER_OPTIONS,
  PRIORITY_OPTIONS,
  STATUS_OPTIONS,
  filterAndSortProjects,
  labelOf,
  stageOptions,
  stageSelectValue,
  type HubProjectFilter,
  type HubProjectSort,
} from "./hubFormat";
import { useHubAction } from "./useHubAction";

const SORT_OPTIONS: ReadonlyArray<{ value: HubProjectSort; label: string }> = [
  { value: "rank", label: "Rank" },
  { value: "name", label: "Name" },
  { value: "recent", label: "Recent" },
];

export function HubProjectsTable(props: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: HubSnapshot;
}) {
  const { snapshot, environmentId } = props;
  const [filter, setFilter] = useState<HubProjectFilter>("open");
  const [sort, setSort] = useState<HubProjectSort>("rank");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<HubProjectView | "new" | null>(null);
  const upsert = useHubAction(
    serverEnvironment.hubUpsertProject,
    environmentId,
    "Could not update the project",
  );
  const importDeez = useHubAction(
    serverEnvironment.hubImport,
    environmentId,
    "Could not import from Deez-Project-Manager",
  );
  const [importNote, setImportNote] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      filterAndSortProjects(snapshot.projects, {
        filter,
        sort,
        query,
        strategy: snapshot.strategy,
      }),
    [filter, query, snapshot.projects, snapshot.strategy, sort],
  );
  const patch = (id: string, change: Omit<HubUpsertProjectInput, "id">) =>
    void upsert.run({ id, ...change });
  const runImport = async () => {
    const result = await importDeez.run({ source: "deez-project-manager" });
    if (result) {
      setImportNote(
        `Imported ${result.imported}, updated ${result.updated}, unchanged ${result.skipped}.`,
      );
    }
  };
  const importButton = snapshot.deezProjectManagerPath ? (
    <Button size="xs" variant="outline" disabled={importDeez.busy} onClick={() => void runImport()}>
      <DownloadIcon className="size-3" />
      {importDeez.busy ? "Importing…" : "Import from Deez-PM"}
    </Button>
  ) : null;

  return (
    <section aria-labelledby="hub-projects-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="hub-projects-heading" className="me-auto text-sm font-medium text-foreground">
          Projects
        </h2>
        <Input
          size="compact"
          type="search"
          aria-label="Search projects"
          placeholder="Search"
          className="w-40"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <CompactSelect label="Show" value={filter} options={FILTER_OPTIONS} onChange={setFilter} />
        <CompactSelect label="Sort" value={sort} options={SORT_OPTIONS} onChange={setSort} />
        {importButton}
        <Button size="xs" onClick={() => setEditing("new")}>
          <PlusIcon className="size-3" />
          Add project
        </Button>
      </div>
      {importNote ? (
        <p role="status" className="text-xs text-muted-foreground">
          {importNote}
        </p>
      ) : null}

      {snapshot.projects.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No projects yet</EmptyTitle>
            <EmptyDescription>
              Import your Deez-Project-Manager backlog or add a project by hand.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center">
            {importButton}
            <Button size="xs" onClick={() => setEditing("new")}>
              Add project
            </Button>
          </EmptyContent>
        </Empty>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No projects match these filters.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table className="min-w-[60rem]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Strategy</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Autonomy</TableHead>
                <TableHead>Review</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((view, index) => (
                <ProjectRow
                  key={view.project.id}
                  index={index}
                  view={view}
                  snapshot={snapshot}
                  onEdit={() => setEditing(view)}
                  onPatch={(change) => patch(view.project.id, change)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {editing !== null ? (
        <HubProjectDialog
          environmentId={environmentId}
          nodeName={snapshot.nodeName}
          view={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}

function ProjectRow(props: {
  readonly index: number;
  readonly view: HubProjectView;
  readonly snapshot: HubSnapshot;
  readonly onEdit: () => void;
  readonly onPatch: (change: Omit<HubUpsertProjectInput, "id">) => void;
}) {
  const { view, snapshot, onPatch } = props;
  const { project } = view;
  const mode = snapshot.settings.sdlcMode;
  const strategyOptions = [
    { value: "", label: "—" },
    ...snapshot.strategy.map((priority) => ({ value: priority.id, label: priority.title })),
  ];
  return (
    <TableRow>
      <TableCell>
        <span className="text-muted-foreground tabular-nums">{props.index + 1}</span>
      </TableCell>
      <TableCell className="max-w-72">
        <button
          type="button"
          onClick={props.onEdit}
          className="flex min-w-0 items-center gap-1.5 rounded-sm text-start font-medium text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {project.favorite ? (
            <StarIcon aria-label="Favourite" className="size-3.5 shrink-0 fill-current" />
          ) : null}
          <span className="truncate">{project.name}</span>
        </button>
        <CheckoutLine view={view} nodeName={snapshot.nodeName} />
      </TableCell>
      <TableCell>
        <CompactSelect
          label={`Strategy for ${project.name}`}
          hideLabel
          value={project.strategyId ?? ""}
          options={strategyOptions}
          onChange={(value) => onPatch({ strategyId: value === "" ? null : value })}
        />
      </TableCell>
      <TableCell>
        <CompactSelect<HubPriority>
          label={`Priority for ${project.name}`}
          hideLabel
          value={project.priority}
          options={PRIORITY_OPTIONS}
          onChange={(priority) => onPatch({ priority })}
        />
      </TableCell>
      <TableCell>
        <CompactSelect<HubProjectStatus>
          label={`Status for ${project.name}`}
          hideLabel
          value={project.status}
          options={STATUS_OPTIONS}
          onChange={(status) => onPatch({ status })}
        />
      </TableCell>
      <TableCell>
        <CompactSelect<HubSdlcStage>
          label={`Stage for ${project.name}`}
          hideLabel
          value={stageSelectValue(project.stage, mode)}
          options={stageOptions(mode)}
          onChange={(stage) => onPatch({ stage })}
        />
      </TableCell>
      <TableCell>
        <CompactSelect<HubAutonomy>
          label={`Autonomy for ${project.name}`}
          hideLabel
          value={project.autonomy}
          options={AUTONOMY_OPTIONS}
          onChange={(autonomy) => onPatch({ autonomy })}
        />
      </TableCell>
      <TableCell>
        <span className="block text-xs text-muted-foreground tabular-nums">
          {view.awaitingReview}/{project.reviewBudget} to review
          {view.running > 0 ? <span className="ms-1.5 text-foreground">· running</span> : null}
          {view.lastLaunchAt ? (
            <span className="block">{formatRelativeTimeLabel(view.lastLaunchAt)}</span>
          ) : null}
        </span>
      </TableCell>
    </TableRow>
  );
}

function CheckoutLine({ view, nodeName }: { view: HubProjectView; nodeName: string }) {
  if (view.localPath === null) {
    return <span className="block text-xs text-muted-foreground">No checkout on {nodeName}</span>;
  }
  if (!view.pathExists) {
    return (
      <span className="flex min-w-0 items-center gap-1 text-xs text-destructive-foreground">
        <FolderXIcon aria-hidden className="size-3 shrink-0" />
        <span className="truncate">Path missing: {view.localPath}</span>
      </span>
    );
  }
  const git = view.git;
  if (git === null) {
    return <span className="block text-xs text-muted-foreground">Not a git repository</span>;
  }
  const parts = [
    git.branch ?? "detached",
    git.ahead > 0 ? `↑${git.ahead}` : null,
    git.behind > 0 ? `↓${git.behind}` : null,
    git.dirty ? "uncommitted changes" : "clean",
  ].filter(Boolean);
  return <span className="block truncate text-xs text-muted-foreground">{parts.join(" · ")}</span>;
}

function CompactSelect<V extends string | number>(props: {
  readonly label: string;
  readonly hideLabel?: boolean;
  readonly value: V;
  readonly options: ReadonlyArray<{ value: V; label: string }>;
  readonly onChange: (value: V) => void;
}) {
  return (
    <Select
      value={props.value}
      onValueChange={(next) => {
        if (next !== null && next !== props.value) props.onChange(next as V);
      }}
    >
      <SelectTrigger size="compact" variant="ghost" aria-label={props.label}>
        {props.hideLabel ? null : <span className="text-muted-foreground">{props.label}:</span>}
        <SelectValue>{labelOf(props.options, props.value)}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {props.options.map((option) => (
          <SelectItem key={String(option.value)} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

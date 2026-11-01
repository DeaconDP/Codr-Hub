import {
  hubProjectViewForNode,
  type EnvironmentId,
  type HubMergedProjectView,
  type HubSnapshot,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { StarIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { serverEnvironment } from "../../state/server";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { HubProjectDialog } from "./HubProjectDialog";
import { filterAndSortProjects, projectGlance, t3SyncSummary } from "./hubFormat";
import { useHubAction } from "./useHubAction";

/** Ranked projects. Tap a row to change it. Rank is the only order. */
export function HubProjectsTable(props: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: HubSnapshot;
  readonly projects: ReadonlyArray<HubMergedProjectView>;
  readonly selectedNodeName: string;
}) {
  const { snapshot, environmentId, projects, selectedNodeName } = props;
  const [query, setQuery] = useState("");
  const [showFinished, setShowFinished] = useState(false);
  const [editing, setEditing] = useState<HubMergedProjectView | "new" | null>(null);
  const importDeez = useHubAction(
    serverEnvironment.hubImport,
    environmentId,
    "Could not import from Deez-Project-Manager",
  );
  const importT3 = useHubAction(
    serverEnvironment.hubImport,
    environmentId,
    "Could not import T3 projects",
  );
  const [importNote, setImportNote] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      filterAndSortProjects(projects, {
        filter: showFinished ? "all" : "open",
        sort: "rank",
        query,
        strategy: snapshot.strategy,
      }),
    [projects, query, showFinished, snapshot.strategy],
  );
  const finishedCount = projects.filter(
    (view) => view.project.archived || view.project.status === "done",
  ).length;
  const runImport = async () => {
    const result = await importDeez.run({ source: "deez-project-manager" });
    if (result) {
      setImportNote(`Imported ${result.imported}, updated ${result.updated}.`);
    }
  };
  const t3Sync = snapshot.t3Sync;
  const syncOn = t3Sync?.enabled === true;
  const runT3Import = async () => {
    const result = await importT3.run({ source: "t3" });
    // With sync on, the snapshot carries the result for every client.
    if (result && !syncOn)
      setImportNote(`${t3SyncSummary(result)} From T3 on ${selectedNodeName}.`);
  };
  const t3Label = syncOn
    ? importT3.busy
      ? "Syncing…"
      : "Sync now"
    : importT3.busy
      ? "Importing…"
      : "Import from T3";
  const t3Note =
    !syncOn || !t3Sync.lastSyncAt ? null : t3Sync.lastError ? (
      <span className="text-destructive-foreground">T3 sync: {t3Sync.lastError}</span>
    ) : (
      `Synced with T3 ${formatRelativeTimeLabel(t3Sync.lastSyncAt)}. ${
        t3Sync.lastResult ? t3SyncSummary(t3Sync.lastResult) : ""
      }`
    );
  const note = importNote ?? t3Note;
  const canImport = snapshot.deezProjectManagerPath !== null && selectedNodeName !== "";
  const canImportT3 = selectedNodeName !== "";

  return (
    <section aria-labelledby="hub-projects-heading" className="flex flex-col gap-3">
      <h2 id="hub-projects-heading" className="text-sm font-medium text-foreground">
        Projects
      </h2>
      {projects.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No projects yet</EmptyTitle>
            <EmptyDescription>Add one, or import the list you already have.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex flex-wrap justify-center gap-2">
              {canImportT3 ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={importT3.busy}
                  onClick={() => void runT3Import()}
                >
                  {t3Label}
                </Button>
              ) : null}
              {canImport ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={importDeez.busy}
                  onClick={() => void runImport()}
                >
                  {importDeez.busy ? "Importing…" : "Import from Deez-PM"}
                </Button>
              ) : null}
              <Button size="sm" onClick={() => setEditing("new")}>
                Add project
              </Button>
            </div>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Input
              size="default"
              type="search"
              aria-label="Search projects"
              placeholder="Search"
              className="min-w-0 flex-1"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button size="sm" onClick={() => setEditing("new")}>
              Add
            </Button>
          </div>
          {note ? (
            <p role="status" className="text-sm text-muted-foreground">
              {note}
            </p>
          ) : null}
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {query.trim() === "" ? "No open projects." : "No matches."}
            </p>
          ) : (
            <ol className="flex flex-col divide-y border-y">
              {rows.map((view, index) => (
                <li key={view.project.id}>
                  <ProjectRow
                    index={index}
                    view={view}
                    snapshot={snapshot}
                    selectedNodeName={selectedNodeName}
                    onEdit={() => setEditing(view)}
                  />
                </li>
              ))}
            </ol>
          )}
          {finishedCount > 0 || canImport || canImportT3 ? (
            <div className="flex flex-wrap gap-2">
              {finishedCount > 0 ? (
                <Button
                  size="sm"
                  variant="ghost-muted"
                  aria-pressed={showFinished}
                  onClick={() => setShowFinished((current) => !current)}
                >
                  {showFinished ? "Hide finished" : `Finished (${finishedCount})`}
                </Button>
              ) : null}
              {canImportT3 ? (
                <Button
                  size="sm"
                  variant="ghost-muted"
                  disabled={importT3.busy}
                  aria-busy={importT3.busy}
                  onClick={() => void runT3Import()}
                >
                  {t3Label}
                </Button>
              ) : null}
              {canImport ? (
                <Button
                  size="sm"
                  variant="ghost-muted"
                  disabled={importDeez.busy}
                  aria-busy={importDeez.busy}
                  onClick={() => void runImport()}
                >
                  {importDeez.busy ? "Importing…" : "Import from Deez-PM"}
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
      {editing !== null ? (
        <HubProjectDialog
          environmentId={environmentId}
          nodeName={selectedNodeName === "" ? snapshot.nodeName : selectedNodeName}
          view={editing === "new" ? null : hubProjectViewForNode(editing, selectedNodeName)}
          strategy={snapshot.strategy}
          sdlcMode={snapshot.settings.sdlcMode}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}

function ProjectRow(props: {
  readonly index: number;
  readonly view: HubMergedProjectView;
  readonly snapshot: HubSnapshot;
  readonly selectedNodeName: string;
  readonly onEdit: () => void;
}) {
  const { project } = props.view;
  const selected = props.view.nodes.find((node) => node.nodeName === props.selectedNodeName);
  const running = selected?.running ?? 0;
  return (
    <div className="flex min-h-11 w-full items-start gap-2 py-3">
      <button
        type="button"
        onClick={props.onEdit}
        className="flex min-w-0 flex-1 items-start gap-3 text-start focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="w-6 shrink-0 pt-0.5 text-sm text-muted-foreground tabular-nums">
          {props.index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 font-medium text-foreground">
            {project.favorite ? (
              <StarIcon aria-label="Favourite" className="size-3.5 shrink-0 fill-current" />
            ) : null}
            <span className="truncate">{project.name}</span>
            {running > 0 ? <RunningBadge count={running} /> : null}
          </span>
          <span className="mt-0.5 block text-sm text-muted-foreground">
            {projectGlance({
              project,
              nodes: props.view.nodes,
              selectedNodeName: props.selectedNodeName,
              strategy: props.snapshot.strategy,
              mode: props.snapshot.settings.sdlcMode,
            })}
          </span>
        </span>
      </button>
      <Button
        size="xs"
        variant="ghost-muted"
        render={<Link to="/hub/projects/$projectId/board" params={{ projectId: project.id }} />}
      >
        Board
      </Button>
    </div>
  );
}

/**
 * The one live indicator for a project's autopilot work (docs/codr-hub/MOTION.md).
 * Mounted only while a job runs; the shine pauses offscreen, in hidden tabs,
 * and under reduced motion.
 */
function RunningBadge({ count }: { count: number }) {
  return (
    <span ref={observeVisibleAnimation} className="live-tool-shine text-sm text-foreground">
      {count > 1 ? `${count} running` : "running"}
    </span>
  );
}

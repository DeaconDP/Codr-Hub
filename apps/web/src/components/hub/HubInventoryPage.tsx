import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectIconColor } from "@t3tools/contracts";
import { localDayKey } from "@t3tools/client-runtime/codrHub/hubActivity";
import {
  attentionList,
  attentionStat,
  buildInventory,
  defaultSortDirection,
  filterInventory,
  INVENTORY_CATEGORIES,
  UNSCANNED,
  type Inventory,
  type InventoryCheckout,
  type InventoryFilters,
  type InventoryMachine,
  type InventorySort,
  type InventorySortKey,
} from "@t3tools/client-runtime/codrHub/inventoryModel";
import { machineColor } from "@t3tools/client-runtime/codrHub/projectPickerModel";
import { scanAllPlan } from "@t3tools/client-runtime/codrHub/scanAllMachines";
import {
  ATTENTION_REASONS,
  type AttentionReason,
} from "@t3tools/client-runtime/codrHub/scanAttention";
import { hubMergedProjectsKey } from "@t3tools/client-runtime/state/server";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useNowMinute } from "../../hooks/useNowMinute";
import { PROJECT_ICON_COLORS, projectIconColorClassName } from "../../projectIconColors";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { HubScanImportDialog } from "./HubScanImportDialog";
import { useEscapeToGoBack } from "./useEscapeToGoBack";
import { useHubAction } from "./useHubAction";

const SORT_KEYS = [
  "name",
  "node",
  "lane",
  "category",
  "vcs",
  "branch",
  "ahead",
  "dirty",
  "lastActivity",
  "size",
] as const satisfies ReadonlyArray<InventorySortKey>;
const REASON_VALUES = ATTENTION_REASONS.map((reason) => reason.value) as [
  AttentionReason,
  ...AttentionReason[],
];

const InventoryPrefs = Schema.Struct({
  query: Schema.String,
  node: Schema.String,
  category: Schema.String,
  lane: Schema.String,
  vcs: Schema.String,
  attentionOnly: Schema.Boolean,
  sortKey: Schema.Literals(SORT_KEYS),
  sortDirection: Schema.Literals(["asc", "desc"]),
  reason: Schema.NullOr(Schema.Literals(REASON_VALUES)),
});
type InventoryPrefs = typeof InventoryPrefs.Type;
const DEFAULT_PREFS: InventoryPrefs = {
  query: "",
  node: "",
  category: "",
  lane: "",
  vcs: "",
  attentionOnly: false,
  sortKey: "node",
  sortDirection: "asc",
  reason: null,
};

const VCS_OPTIONS = [
  { value: "github", label: "GitHub" },
  { value: "edgar", label: "Edgar" },
  { value: "perforce", label: "Perforce" },
  { value: "git-local", label: "Local git" },
  { value: "none", label: "No version control" },
  { value: UNSCANNED, label: "Not scanned" },
];

const COLUMNS: ReadonlyArray<{ key: InventorySortKey; label: string; numeric?: boolean }> = [
  { key: "name", label: "Project" },
  { key: "node", label: "Machine" },
  { key: "lane", label: "Lane" },
  { key: "category", label: "Category" },
  { key: "vcs", label: "Version control" },
  { key: "branch", label: "Branch" },
  { key: "ahead", label: "±", numeric: true },
  { key: "dirty", label: "Dirty", numeric: true },
  { key: "lastActivity", label: "Last activity", numeric: true },
  { key: "size", label: "Size GB", numeric: true },
];

const FLAG_VARIANT: Record<string, "error" | "warning" | "secondary"> = {
  "at-risk": "error",
  duplicate: "warning",
  "half-copy": "warning",
};

const count = (value: number) => value.toLocaleString();
/** Parent and folder, so two copies with the same folder name stay apart. */
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
const sharedColor = (colors: ReadonlyArray<ProjectIconColor>) =>
  new Set(colors).size < colors.length;
const plural = (value: number, one: string, many: string) =>
  `${count(value)} ${value === 1 ? one : many}`;

function monthLabel(month: string) {
  return new Date(`${month}-01T00:00:00Z`).toLocaleString(undefined, {
    month: "short",
    timeZone: "UTC",
  });
}

function scanDateLabel(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Codr-Hub: every folder the disk scans found, by machine, with what needs a look. */
export function HubInventoryPage() {
  useEscapeToGoBack();
  const nowMinute = useNowMinute();
  const { environments } = useEnvironments();
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const mergeKey = hubMergedProjectsKey(
    environments.map((entry) => ({
      environmentId: entry.environmentId,
      phase: entry.connection.phase,
    })),
  );
  const merged = useAtomValue(
    mergeKey === null
      ? serverEnvironment.hubMergedProjectsEmpty
      : serverEnvironment.hubMergedProjects(mergeKey),
  );
  const [prefs, setPrefs] = useLocalStorage("codr-hub:inventory", DEFAULT_PREFS, InventoryPrefs);
  const [importFor, setImportFor] = useState<string | null>(null);
  const [coloring, setColoring] = useState(false);

  const hubEnvironmentId = merged.hubEnvironmentIds[0];
  const hubEnvironment =
    hubEnvironmentId === undefined
      ? null
      : ([hubEnvironmentId, merged.nodeNameByEnvironmentId.get(hubEnvironmentId) ?? ""] as const);
  const nodeColors = merged.anySnapshot?.settings.nodeColors ?? {};
  const inventory = buildInventory({
    projects: merged.projects.map((view) => view.project),
    extraNodes: [...new Set(merged.nodeNameByEnvironmentId.values())],
    today: localDayKey(new Date(Date.parse(`${nowMinute}:00Z`))),
  });
  const colorOf = (node: string) => machineColor(node, nodeColors);
  const update = (patch: Partial<InventoryPrefs>) =>
    setPrefs((current) => ({ ...current, ...patch }));

  const header = (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-2">
      <WorkspaceBreadcrumb ariaLabel="Hub breadcrumb" className="min-w-0">
        <WorkspaceBreadcrumbItem>
          <Link to="/hub" className="hover:underline">
            Hub
          </Link>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current>
          <h1>Inventory</h1>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      <Button size="xs" variant="ghost-muted" render={<Link to="/hub/dashboard" />}>
        Dashboard
      </Button>
    </div>
  );

  const loading = merged.anySnapshot === null && (merged.isPending || merged.error === null);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          {header}
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {connected.length === 0 && merged.anySnapshot === null ? (
              <p className="text-sm text-muted-foreground">
                Connect an environment to open the inventory.
              </p>
            ) : merged.anySnapshot === null && merged.error !== null && !merged.isPending ? (
              <div role="alert" className="flex flex-col items-start gap-1 text-sm">
                <p>Could not load the hub.</p>
                <p className="text-muted-foreground">{merged.error}</p>
              </div>
            ) : loading ? (
              <div className="flex flex-col gap-3" role="status" aria-label="Loading inventory">
                <Skeleton className="h-16 w-full" />
                <Skeleton shape="card" className="h-48 w-full" />
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                <Totals inventory={inventory} />
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <h2 className="text-base font-semibold">Machines</h2>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {sharedColor(inventory.machines.map((machine) => colorOf(machine.node))) ? (
                        <span className="text-xs text-muted-foreground">
                          Some machines share a colour.
                        </span>
                      ) : null}
                      {hubEnvironment ? (
                        <Button size="xs" variant="ghost-muted" onClick={() => setColoring(true)}>
                          Machine colours…
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <section
                    aria-label="Machines"
                    className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
                  >
                    {inventory.machines.map((machine) => (
                      <MachineCard
                        key={machine.node}
                        machine={machine}
                        color={colorOf(machine.node)}
                        selected={prefs.node === machine.node}
                        onSelect={() =>
                          update({ node: prefs.node === machine.node ? "" : machine.node })
                        }
                        onImport={hubEnvironment ? () => setImportFor(machine.node) : null}
                      />
                    ))}
                  </section>
                </div>
                {inventory.totals.checkouts > 0 ? (
                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
                    <AttentionPanel
                      inventory={inventory}
                      reason={prefs.reason}
                      onReason={(reason) => update({ reason })}
                      colorOf={colorOf}
                    />
                    <div className="flex min-w-0 flex-col gap-4">
                      <LaneMatrix inventory={inventory} colorOf={colorOf} />
                      <ActivityChart inventory={inventory} colorOf={colorOf} />
                    </div>
                  </div>
                ) : null}
                <InventoryTable
                  inventory={inventory}
                  prefs={prefs}
                  update={update}
                  colorOf={colorOf}
                />
                <p className="max-w-[70ch] text-xs text-muted-foreground">
                  From the latest disk scan of each machine; it changes when you import a new one.
                  Dirty is the number of uncommitted files, ± is commits ahead and behind the
                  upstream at scan time. Unity, Unreal and VRChat folders without git don't count as
                  having no remote.
                </p>
              </div>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      {coloring && hubEnvironment ? (
        <MachineColorsDialog
          environmentId={hubEnvironment[0]}
          machines={inventory.machines.map((machine) => ({
            node: machine.node,
            color: colorOf(machine.node),
            custom: nodeColors[machine.node] !== undefined,
          }))}
          onClose={() => setColoring(false)}
        />
      ) : null}
      {importFor !== null && hubEnvironment ? (
        <HubScanImportDialog
          environmentId={hubEnvironment[0]}
          nodeName={hubEnvironment[1]}
          initialMachine={importFor === hubEnvironment[1] ? undefined : importFor}
          knownNodes={inventory.machines.map((machine) => machine.node)}
          scanAllPlan={scanAllPlan({
            hubEnvironmentIds: merged.hubEnvironmentIds,
            connectedEnvironmentIds: connected.map((entry) => entry.environmentId),
            nodeNameByEnvironmentId: merged.nodeNameByEnvironmentId,
            projects: merged.projects,
          })}
          onClose={() => setImportFor(null)}
        />
      ) : null}
    </SidebarInset>
  );
}

function Totals(props: { inventory: Inventory }) {
  const { totals } = props.inventory;
  const tiles: ReadonlyArray<{ label: string; value: string; detail?: string; alert?: boolean }> = [
    {
      label: "Projects scanned",
      value: count(totals.projects),
      detail: `${plural(totals.checkouts, "checkout", "checkouts")}${
        totals.notScanned > 0 ? ` · ${count(totals.notScanned)} not scanned` : ""
      }`,
    },
    {
      label: "Have a remote",
      value: `${Math.round(totals.remoteShare * 100)}%`,
      detail: "of checkouts",
    },
    { label: "Uncommitted work", value: count(totals.dirtyCheckouts), detail: "checkouts" },
    { label: "Unpushed commits", value: count(totals.unpushedCheckouts), detail: "checkouts" },
    {
      label: "Need attention",
      value: count(totals.attentionProjects),
      detail: `projects · ${plural(totals.attentionCheckouts, "checkout", "checkouts")}`,
      alert: totals.attentionProjects > 0,
    },
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map((tile) => (
        <div key={tile.label} className="flex flex-col gap-0.5 rounded-lg border bg-card p-3">
          <dt className="text-xs text-muted-foreground">{tile.label}</dt>
          <dd
            className={`text-2xl font-semibold tabular-nums ${tile.alert ? "text-destructive-foreground" : ""}`}
          >
            {tile.value}
          </dd>
          {tile.detail ? (
            <dd className="text-xs tabular-nums text-muted-foreground">{tile.detail}</dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}

function Swatch(props: { color: ProjectIconColor; className?: string }) {
  return (
    <span
      aria-hidden
      className={`shrink-0 bg-current ${projectIconColorClassName(props.color)} ${props.className ?? "size-2 rounded-sm"}`}
    />
  );
}

function MachineCard(props: {
  machine: InventoryMachine;
  color: ProjectIconColor;
  selected: boolean;
  onSelect: () => void;
  onImport: (() => void) | null;
}) {
  const { machine } = props;
  const colorClass = projectIconColorClassName(props.color);
  const share = (value: number) => `${(value / machine.checkouts) * 100}%`;
  const head = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="truncate text-base font-semibold">{machine.node}</h3>
        <p className="text-xs text-muted-foreground">
          {machine.lastScan ? `Scanned ${scanDateLabel(machine.lastScan)}` : "No scan yet"}
        </p>
      </div>
      {machine.checkouts > 0 ? (
        <span className={`text-3xl font-semibold leading-none tabular-nums ${colorClass}`}>
          {count(machine.checkouts)}
        </span>
      ) : null}
    </div>
  );
  const frame = "relative flex flex-col gap-3 overflow-hidden rounded-lg border bg-card p-4 pt-5";
  const accent = (
    <span aria-hidden className={`absolute inset-x-0 top-0 h-[3px] bg-current ${colorClass}`} />
  );

  if (machine.checkouts === 0) {
    return (
      <div className={frame}>
        {accent}
        {head}
        <p className="text-sm text-muted-foreground">
          {machine.unscanned > 0
            ? `The Hub knows ${plural(machine.unscanned, "checkout", "checkouts")} here, but no scan has been imported.`
            : "No scan has been imported for this machine."}
        </p>
        {props.onImport ? (
          <div>
            <Button size="xs" variant="outline" onClick={props.onImport}>
              Import scan…
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={props.selected}
      aria-label={`${machine.node}: ${plural(machine.checkouts, "checkout", "checkouts")}. ${
        props.selected ? "Show every machine in the list" : "Show only this machine in the list"
      }`}
      onClick={props.onSelect}
      className={`${frame} text-start outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
        props.selected ? "ring-2 ring-current ring-inset" : ""
      } ${props.selected ? colorClass : ""}`}
    >
      {accent}
      <div className="contents text-foreground">
        {head}
        <div className="flex flex-col gap-1.5">
          <div
            role="img"
            aria-label={`${machine.remote} with a remote, ${machine.local} local git only, ${machine.none} no version control`}
            className="flex h-2.5 gap-0.5 overflow-hidden rounded-sm bg-muted"
          >
            {machine.remote > 0 ? (
              <span
                className={`bg-current ${colorClass}`}
                style={{ width: share(machine.remote) }}
              />
            ) : null}
            {machine.local > 0 ? (
              <span
                className={`bg-current opacity-40 ${colorClass}`}
                style={{ width: share(machine.local) }}
              />
            ) : null}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
            <span className="flex items-center gap-1.5">
              <Swatch color={props.color} />
              {count(machine.remote)} remote
            </span>
            <span className="flex items-center gap-1.5">
              <Swatch color={props.color} className="size-2 rounded-sm opacity-40" />
              {count(machine.local)} local git
            </span>
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2 rounded-sm bg-muted ring-1 ring-border ring-inset"
              />
              {count(machine.none)} no git
            </span>
          </div>
        </div>
        <dl className="grid grid-cols-4 gap-1.5 border-t pt-3">
          {INVENTORY_CATEGORIES.map((category) => (
            <div key={category} className="flex flex-col-reverse">
              <dt className="text-xs text-muted-foreground">{category}</dt>
              <dd className="text-sm font-semibold tabular-nums">
                {count(machine.categories[category] ?? 0)}
              </dd>
            </div>
          ))}
        </dl>
        {machine.unscanned > 0 ? (
          <p className="text-xs text-muted-foreground">
            {plural(machine.unscanned, "checkout", "checkouts")} not scanned
          </p>
        ) : null}
      </div>
    </button>
  );
}

function Panel(props: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">{props.title}</h2>
        {props.note ? <span className="text-xs text-muted-foreground">{props.note}</span> : null}
      </div>
      {props.children}
    </section>
  );
}

function AttentionPanel(props: {
  inventory: Inventory;
  reason: AttentionReason | null;
  onReason: (reason: AttentionReason) => void;
  colorOf: (node: string) => ProjectIconColor;
}) {
  const { inventory } = props;
  const firstWithRows =
    ATTENTION_REASONS.find((reason) => inventory.reasonCounts[reason.value] > 0)?.value ??
    "at-risk";
  const reason = props.reason ?? firstWithRows;
  const info = ATTENTION_REASONS.find((entry) => entry.value === reason)!;
  const rows = attentionList(inventory.rows, reason);
  return (
    <Panel
      title="What needs attention"
      note={`${plural(inventory.totals.attentionCheckouts, "checkout", "checkouts")} in ${plural(inventory.totals.attentionProjects, "project", "projects")}`}
    >
      <div role="group" aria-label="Reasons" className="flex flex-wrap gap-1.5">
        {ATTENTION_REASONS.map((entry) => (
          <Toggle
            key={entry.value}
            variant="outline"
            size="xs"
            pressed={entry.value === reason}
            onPressedChange={() => props.onReason(entry.value)}
          >
            {entry.label}
            <span className="tabular-nums text-muted-foreground">
              {inventory.reasonCounts[entry.value]}
            </span>
          </Toggle>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing here.</p>
      ) : (
        <ul className="flex max-h-96 flex-col divide-y overflow-y-auto border-t">
          {rows.map((row) => (
            <AttentionRow
              key={row.key}
              row={row}
              why={info.why}
              risk={reason === "at-risk"}
              color={props.colorOf(row.node)}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function AttentionRow(props: {
  row: InventoryCheckout;
  why: string;
  risk: boolean;
  color: ProjectIconColor;
}) {
  const { row } = props;
  return (
    <li className="grid grid-cols-[0.5rem_minmax(0,1fr)_auto] items-center gap-2.5 py-2">
      <Swatch color={props.color} className="size-2 rounded-full" />
      <div className="min-w-0">
        <Link
          to="/hub/projects/$projectId/board"
          params={{ projectId: row.projectId }}
          title={row.path}
          className={`block truncate text-sm font-medium hover:underline ${props.risk ? "text-destructive-foreground" : ""}`}
        >
          {row.projectName}
        </Link>
        <p className="truncate text-xs text-muted-foreground">
          {[row.node, row.scan?.engine, row.primary ? null : folderName(row.path), props.why]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
        {attentionStat(row)}
      </span>
    </li>
  );
}

function LaneMatrix(props: { inventory: Inventory; colorOf: (node: string) => ProjectIconColor }) {
  const { lanes, nodes, counts, max } = props.inventory.lanes;
  const machines = props.inventory.machines;
  return (
    <Panel title="Lanes by machine" note="scanned checkouts">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm tabular-nums">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th scope="col" className="px-2 py-1.5 text-start font-medium">
                Lane
              </th>
              {nodes.map((node) => (
                <th key={node} scope="col" className="px-2 py-1.5 text-end font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    <Swatch color={props.colorOf(node)} />
                    {node}
                  </span>
                </th>
              ))}
              <th scope="col" className="px-2 py-1.5 text-end font-medium">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {lanes.map((lane, laneIndex) => {
              const row = counts[laneIndex]!;
              return (
                <tr key={lane}>
                  <th scope="row" className="px-2 py-1 text-start font-normal">
                    {lane}
                  </th>
                  {row.map((value, nodeIndex) =>
                    value === 0 ? (
                      <td
                        key={nodes[nodeIndex]}
                        className="px-2 py-1 text-end text-muted-foreground/60"
                      >
                        –
                      </td>
                    ) : (
                      <td
                        key={nodes[nodeIndex]}
                        aria-label={`${nodes[nodeIndex]}, ${lane}: ${value}`}
                        className="relative px-2 py-1 text-end"
                      >
                        <span
                          aria-hidden
                          className={`absolute inset-0.5 rounded bg-current ${projectIconColorClassName(props.colorOf(nodes[nodeIndex]!))}`}
                          style={{ opacity: 0.1 + (0.45 * value) / Math.max(1, max) }}
                        />
                        <span className="relative">{value}</span>
                      </td>
                    ),
                  )}
                  <td className="px-2 py-1 text-end">
                    {row.reduce((sum, value) => sum + value, 0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t font-semibold">
              <th scope="row" className="px-2 py-1.5 text-start">
                All
              </th>
              {machines.map((machine) => (
                <td key={machine.node} className="px-2 py-1.5 text-end">
                  {machine.checkouts}
                </td>
              ))}
              <td className="px-2 py-1.5 text-end">{props.inventory.totals.checkouts}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Panel>
  );
}

function ActivityChart(props: {
  inventory: Inventory;
  colorOf: (node: string) => ProjectIconColor;
}) {
  const { months, nodes, counts, older } = props.inventory.activity;
  const totals = counts.map((row) => row.reduce((sum, value) => sum + value, 0));
  const peak = Math.max(0, ...totals);
  const shown = nodes.filter((_, nodeIndex) => counts.some((row) => row[nodeIndex]! > 0));
  return (
    <Panel
      title="Last activity"
      note={`by month, excluding Archive${peak > 0 ? ` · peak ${peak}` : ""}`}
    >
      <div
        role="list"
        aria-label="Checkouts by month of last activity"
        className="flex h-36 items-end gap-1"
      >
        {months.map((month, monthIndex) => {
          const total = totals[monthIndex]!;
          const label = `${monthLabel(month)} ${month.slice(0, 4)}: ${total}${
            total > 0
              ? ` (${nodes
                  .map((node, nodeIndex) => [node, counts[monthIndex]![nodeIndex]!] as const)
                  .filter(([, value]) => value > 0)
                  .map(([node, value]) => `${node} ${value}`)
                  .join(", ")})`
              : ""
          }`;
          return (
            <Tooltip key={month}>
              <TooltipTrigger
                render={
                  <div
                    role="listitem"
                    aria-label={label}
                    className="flex h-full min-w-0 flex-1 flex-col justify-end hover:bg-accent"
                  />
                }
              >
                <div
                  className="flex flex-col-reverse gap-0.5 overflow-hidden rounded-t"
                  style={{ height: peak === 0 || total === 0 ? 0 : `${(total / peak) * 100}%` }}
                >
                  {nodes.map((node, nodeIndex) => {
                    const value = counts[monthIndex]![nodeIndex]!;
                    return value === 0 ? null : (
                      <span
                        key={node}
                        className={`block min-h-px bg-current ${projectIconColorClassName(props.colorOf(node))}`}
                        style={{ flexGrow: value, flexBasis: 0 }}
                      />
                    );
                  })}
                </div>
              </TooltipTrigger>
              <TooltipPopup side="top">{label}</TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
      <div aria-hidden className="flex gap-1 text-3xs text-muted-foreground">
        {months.map((month) => (
          <span key={month} className="min-w-0 flex-1 truncate text-center">
            {monthLabel(month)}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
        {shown.map((node) => (
          <span key={node} className="flex items-center gap-1.5">
            <Swatch color={props.colorOf(node)} />
            {node}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-sm bg-muted ring-1 ring-border ring-inset" />
          {count(older)} older than {monthLabel(months[0]!)} {months[0]!.slice(0, 4)}
        </span>
      </div>
    </Panel>
  );
}

const ALL = "all";

function FilterSelect(props: {
  label: string;
  allLabel: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const current = props.options.find((option) => option.value === props.value);
  return (
    <div className="min-w-0 sm:w-40 sm:shrink-0">
      <Select
        value={props.value === "" ? ALL : props.value}
        onValueChange={(next) => props.onChange(next === null || next === ALL ? "" : String(next))}
      >
        <SelectTrigger aria-label={props.label}>
          <SelectValue>{current?.label ?? props.allLabel}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={ALL}>{props.allLabel}</SelectItem>
          {props.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

function InventoryTable(props: {
  inventory: Inventory;
  prefs: InventoryPrefs;
  update: (patch: Partial<InventoryPrefs>) => void;
  colorOf: (node: string) => ProjectIconColor;
}) {
  const { inventory, prefs, update } = props;
  const filters: InventoryFilters = prefs;
  const sort: InventorySort = { key: prefs.sortKey, direction: prefs.sortDirection };
  const rows = filterInventory(inventory.rows, filters, sort);
  const toggleSort = (key: InventorySortKey) =>
    update(
      prefs.sortKey === key
        ? { sortDirection: prefs.sortDirection === "asc" ? "desc" : "asc" }
        : { sortKey: key, sortDirection: defaultSortDirection(key) },
    );
  return (
    <Panel title="All checkouts" note={`${count(rows.length)} of ${count(inventory.rows.length)}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          aria-label="Search checkouts"
          placeholder="Search name or branch"
          className="min-w-40 flex-1"
          value={prefs.query}
          onChange={(event) => update({ query: event.target.value })}
        />
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
          <FilterSelect
            label="Machine"
            allLabel="All machines"
            value={prefs.node}
            options={inventory.machines.map((machine) => ({
              value: machine.node,
              label: machine.node,
            }))}
            onChange={(node) => update({ node })}
          />
          <FilterSelect
            label="Category"
            allLabel="All categories"
            value={prefs.category}
            options={INVENTORY_CATEGORIES.map((category) => ({ value: category, label: category }))}
            onChange={(category) => update({ category })}
          />
          <FilterSelect
            label="Lane"
            allLabel="All lanes"
            value={prefs.lane}
            options={inventory.laneOptions.map((lane) => ({ value: lane, label: lane }))}
            onChange={(lane) => update({ lane })}
          />
          <FilterSelect
            label="Version control"
            allLabel="Any version control"
            value={prefs.vcs}
            options={VCS_OPTIONS}
            onChange={(vcs) => update({ vcs })}
          />
        </div>
        <label className="flex min-h-9 items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            checked={prefs.attentionOnly}
            onCheckedChange={(checked) => update({ attentionOnly: checked === true })}
          />
          Needs attention only
        </label>
      </div>
      <div className="max-h-[640px] overflow-auto rounded-md border">
        <table className="w-full min-w-[880px] border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr className="border-b">
              {COLUMNS.map((column) => {
                const active = prefs.sortKey === column.key;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={
                      active
                        ? prefs.sortDirection === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                    className="p-0"
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(column.key)}
                      className={`flex w-full items-center gap-1 px-2.5 py-2 text-xs font-medium whitespace-nowrap outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                        column.numeric ? "justify-end" : ""
                      } ${active ? "text-foreground" : "text-muted-foreground"}`}
                    >
                      {column.label}
                      {active ? (
                        <span aria-hidden>{prefs.sortDirection === "asc" ? "↑" : "↓"}</span>
                      ) : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={COLUMNS.length}
                  className="px-2.5 py-6 text-center text-muted-foreground"
                >
                  No checkouts match.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <InventoryRow key={row.key} row={row} color={props.colorOf(row.node)} />
              ))
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function InventoryRow(props: { row: InventoryCheckout; color: ProjectIconColor }) {
  const { row } = props;
  const scan = row.scan;
  const ahead = scan?.ahead ?? 0;
  const dirty = scan?.dirty ?? null;
  const aheadBehind =
    scan === null || (scan.ahead === null && scan.behind === null)
      ? ""
      : `+${scan.ahead ?? 0} −${scan.behind ?? 0}`;
  return (
    <tr
      className={`border-b last:border-0 hover:bg-muted/50 ${row.archived ? "text-muted-foreground" : ""}`}
    >
      <td className="max-w-72 px-2.5 py-1.5 align-top">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <Link
            to="/hub/projects/$projectId/board"
            params={{ projectId: row.projectId }}
            title={row.path}
            className="min-w-0 truncate font-medium hover:underline"
          >
            {row.projectName}
          </Link>
          {(scan?.flags ?? []).map((flag) => (
            <Badge key={flag} size="sm" variant={FLAG_VARIANT[flag] ?? "secondary"}>
              {flag}
            </Badge>
          ))}
        </div>
      </td>
      <td className="px-2.5 py-1.5 align-top whitespace-nowrap">
        <span className="inline-flex items-center gap-1.5 text-xs">
          <Swatch color={props.color} />
          {row.node}
        </span>
      </td>
      <td className="px-2.5 py-1.5 align-top whitespace-nowrap">{scan?.engine ?? ""}</td>
      <td className="px-2.5 py-1.5 align-top whitespace-nowrap">{scan?.category ?? ""}</td>
      <td
        className={`px-2.5 py-1.5 align-top font-mono text-xs whitespace-nowrap ${
          scan === null || scan.vcs === "none" ? "text-muted-foreground" : ""
        }`}
      >
        {scan?.vcs ?? "not scanned"}
      </td>
      <td className="max-w-40 truncate px-2.5 py-1.5 align-top font-mono text-xs">
        {scan?.branch ?? ""}
      </td>
      <td
        className={`px-2.5 py-1.5 text-end align-top font-mono text-xs whitespace-nowrap ${
          ahead > 0 ? "font-semibold text-warning-foreground" : ""
        }`}
      >
        {aheadBehind}
      </td>
      <td
        className={`px-2.5 py-1.5 text-end align-top tabular-nums ${
          dirty !== null && dirty >= 20 ? "font-semibold text-destructive-foreground" : ""
        }`}
      >
        {dirty ?? ""}
      </td>
      <td className="px-2.5 py-1.5 text-end align-top font-mono text-xs whitespace-nowrap">
        {scan?.lastActivity ?? ""}
      </td>
      <td className="px-2.5 py-1.5 text-end align-top tabular-nums">
        {scan?.sizeGb === null || scan?.sizeGb === undefined ? "" : scan.sizeGb.toFixed(1)}
      </td>
    </tr>
  );
}

/** Every machine the scans know, connected or not; the picker's dialog lists only connected ones. */
function MachineColorsDialog(props: {
  environmentId: EnvironmentId;
  machines: ReadonlyArray<{ node: string; color: ProjectIconColor; custom: boolean }>;
  onClose: () => void;
}) {
  const save = useHubAction(
    serverEnvironment.hubUpdateSettings,
    props.environmentId,
    "Could not save the machine colour",
  );
  const pick = (node: string, color: ProjectIconColor | null) =>
    void save.run({ nodeColors: { [node]: color } });
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Machine colours</DialogTitle>
          <DialogDescription>
            Each machine gets a colour automatically. Pick one to change it on every device.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ul className="flex flex-col gap-3">
            {props.machines.map((machine) => (
              <li key={machine.node} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2 text-sm">
                  <Swatch color={machine.color} className="size-3 rounded-full" />
                  <span className="min-w-0 truncate font-medium">{machine.node}</span>
                  {machine.custom ? (
                    <span className="ms-auto">
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        disabled={save.busy}
                        onClick={() => pick(machine.node, null)}
                      >
                        Use automatic
                      </Button>
                    </span>
                  ) : (
                    <span className="ms-auto text-xs text-muted-foreground">Automatic</span>
                  )}
                </div>
                <div
                  role="radiogroup"
                  aria-label={`Colour for ${machine.node}`}
                  className="flex flex-wrap gap-1"
                >
                  {PROJECT_ICON_COLORS.filter((option) => option.value !== "gray").map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={machine.color === option.value}
                      aria-label={option.label}
                      disabled={save.busy}
                      onClick={() => pick(machine.node, option.value)}
                      className={`size-5 rounded-full ${option.swatchClassName} focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-checked:ring-2 aria-checked:ring-inset aria-checked:ring-foreground disabled:opacity-50`}
                    />
                  ))}
                </div>
              </li>
            ))}
          </ul>
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

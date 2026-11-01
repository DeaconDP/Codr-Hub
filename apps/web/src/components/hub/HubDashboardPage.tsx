import { useAtomValue } from "@effect/atom-react";
import {
  HUB_PLATFORM_LABELS,
  type HubActivityWindow,
  type HubPlatform,
  type HubSdlcMode,
  type ProjectIconColor,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { isElectron } from "../../env";
import { useEscapeToGoBack } from "./useEscapeToGoBack";
import { projectIconColorClassName } from "../../projectIconColors";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useNowMinute } from "../../hooks/useNowMinute";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Toggle } from "../ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  HUB_ACTIVITY_WINDOWS,
  HUB_PLATFORM_COLORS,
  HUB_PLATFORM_ORDER,
  buildHubDashboard,
  type HubDashboard,
  type HubDashboardMachine,
  type HubDashboardSizeMode,
  type HubDashboardTile,
} from "./hubDashboardModel";
import {
  PRIORITY_OPTIONS,
  STATUS_OPTIONS,
  labelOf,
  stageOptions,
  stageSelectValue,
} from "./hubFormat";
import { squarifyTreemap, type TreemapRect } from "./hubTreemap";
import { machineColor } from "./projectPickerModel";

const MACHINE_GAP = 6;
const MACHINE_HEADER = 30;
const MACHINE_PADDING = 4;
const TILE_GAP = 2;
/** Smallest share of the map a machine gets, so its header always fits. */
const MACHINE_MIN_SHARE = 0.06;

const INK = { white: "#ffffff", ink: "#0b0b0b" } as const;

function platformFill(platform: HubPlatform) {
  const colors = HUB_PLATFORM_COLORS[platform];
  return `light-dark(${colors.light}, ${colors.dark})`;
}

function tileStyle(tile: HubDashboardTile, rect: TreemapRect): CSSProperties {
  const colors = HUB_PLATFORM_COLORS[tile.platform];
  const fill = platformFill(tile.platform);
  const position = { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
  if (tile.dimmed) {
    return {
      ...position,
      background: `color-mix(in srgb, ${fill} 16%, var(--card))`,
      boxShadow: `inset 3px 0 0 ${fill}`,
      color: "var(--foreground)",
    };
  }
  return {
    ...position,
    background: `linear-gradient(to bottom, rgb(255 255 255 / 0.14), rgb(255 255 255 / 0) 60%), ${fill}`,
    color: `light-dark(${INK[colors.inkLight]}, ${INK[colors.inkDark]})`,
  };
}

/** Map height from width: wide screens get a landscape map, phones a tall one. */
function mapHeight(width: number) {
  if (width < 640) return Math.max(560, Math.round(width * 1.7));
  return Math.round(Math.min(Math.max(width * 0.58, 460), 860));
}

type PlacedMachine = {
  readonly machine: HubDashboardMachine;
  readonly box: TreemapRect;
  readonly tiles: ReadonlyArray<{ readonly tile: HubDashboardTile; readonly rect: TreemapRect }>;
};

function inset(rect: TreemapRect, by: number): TreemapRect {
  return {
    x: rect.x + by,
    y: rect.y + by,
    width: Math.max(0, rect.width - by * 2),
    height: Math.max(0, rect.height - by * 2),
  };
}

function layoutDashboard(dashboard: HubDashboard, width: number, height: number): PlacedMachine[] {
  const total = dashboard.machines.reduce((sum, machine) => sum + machine.weight, 0);
  const byKey = new Map(dashboard.machines.map((machine) => [machine.key, machine]));
  const outer = squarifyTreemap(
    dashboard.machines.map((machine) => ({
      id: machine.key,
      weight: Math.max(machine.weight, total * MACHINE_MIN_SHARE),
    })),
    { x: 0, y: 0, width, height },
  );
  return outer.map((cell) => {
    const machine = byKey.get(cell.id)!;
    const box = inset(cell, MACHINE_GAP / 2);
    const inner: TreemapRect = {
      x: MACHINE_PADDING - TILE_GAP / 2,
      y: MACHINE_HEADER - TILE_GAP / 2,
      width: Math.max(0, box.width - MACHINE_PADDING * 2 + TILE_GAP),
      height: Math.max(0, box.height - MACHINE_HEADER - MACHINE_PADDING + TILE_GAP),
    };
    const tileByKey = new Map(machine.tiles.map((tile) => [tile.key, tile]));
    const tiles = squarifyTreemap(
      machine.tiles.map((tile) => ({ id: tile.key, weight: tile.weight })),
      inner,
    ).map((rect) => ({ tile: tileByKey.get(rect.id)!, rect: inset(rect, TILE_GAP / 2) }));
    return { machine, box, tiles };
  });
}

/** Codr-Hub: every project as a treemap, grouped by machine and coloured by platform. */
export function HubDashboardPage() {
  useEscapeToGoBack();
  useNowMinute();
  const { environments } = useEnvironments();
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const connectedKey = JSON.stringify(connected.map((entry) => entry.environmentId));
  const merged = useAtomValue(
    connected.length === 0
      ? serverEnvironment.hubMergedProjectsEmpty
      : serverEnvironment.hubMergedProjects(connectedKey),
  );
  const insights = useHubInsights(connected.length === 0 ? null : connectedKey);

  const [mode, setMode] = useState<HubDashboardSizeMode>("importance");
  const [activityWindow, setActivityWindow] = useState<HubActivityWindow>("7d");
  const [hidden, setHidden] = useState<ReadonlySet<HubPlatform>>(() => new Set());

  const settings = merged.anySnapshot?.settings;
  const strategy = merged.anySnapshot?.strategy;
  const dashboard = useMemo(
    () =>
      buildHubDashboard({
        projects: merged.projects,
        insights: insights.insights,
        strategy: strategy ?? [],
        mode,
        window: activityWindow,
        hiddenPlatforms: hidden,
      }),
    [merged.projects, insights.insights, strategy, mode, activityWindow, hidden],
  );

  const togglePlatform = (platform: HubPlatform) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(platform)) next.delete(platform);
      else next.add(platform);
      return next;
    });

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
          <h1>Dashboard</h1>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
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
            {connected.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Connect an environment to open the dashboard.
              </p>
            ) : merged.anySnapshot === null && merged.error !== null && !merged.isPending ? (
              <div role="alert" className="flex flex-col items-start gap-1 text-sm">
                <p>Could not load the hub.</p>
                <p className="text-muted-foreground">{merged.error}</p>
              </div>
            ) : loading ? (
              <div className="flex flex-col gap-3" role="status" aria-label="Loading dashboard">
                <Skeleton className="h-7 w-80 max-w-full" />
                <Skeleton shape="card" className="h-96 w-full" />
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <ToggleGroup
                    aria-label="Size tiles by"
                    variant="segmented"
                    value={[mode]}
                    onValueChange={(next) => {
                      const value = next[0];
                      if (value === "importance" || value === "activity") setMode(value);
                    }}
                  >
                    <ToggleGroupItem value="importance">Importance</ToggleGroupItem>
                    <ToggleGroupItem value="activity">Activity</ToggleGroupItem>
                  </ToggleGroup>
                  <ToggleGroup
                    aria-label="Commit window"
                    variant="segmented"
                    value={[activityWindow]}
                    onValueChange={(next) => {
                      const value = HUB_ACTIVITY_WINDOWS.find((entry) => entry.value === next[0]);
                      if (value) setActivityWindow(value.value);
                    }}
                  >
                    {HUB_ACTIVITY_WINDOWS.map((entry) => (
                      <ToggleGroupItem key={entry.value} value={entry.value}>
                        {entry.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  <ActivityNote error={insights.error} pending={insights.isPending} />
                </div>
                <PlatformLegend
                  counts={dashboard.platformCounts}
                  hidden={hidden}
                  onToggle={togglePlatform}
                  onShowAll={() => setHidden(new Set())}
                />
                {dashboard.machines.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {dashboard.projectCount === 0
                      ? "No projects yet. Add one from the Hub."
                      : "No projects match the platform filter."}
                  </p>
                ) : (
                  <DashboardMap
                    dashboard={dashboard}
                    window={activityWindow}
                    nodeColors={settings?.nodeColors ?? {}}
                    sdlcMode={settings?.sdlcMode ?? "three"}
                  />
                )}
              </div>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

/** Commit activity per connected node; the only read of insight state on this page. */
function useHubInsights(connectedKey: string | null) {
  return useAtomValue(
    connectedKey === null
      ? serverEnvironment.hubMergedInsightsEmpty
      : serverEnvironment.hubMergedInsights(connectedKey),
  );
}

function ActivityNote(props: { error: string | null; pending: boolean }) {
  if (props.error !== null) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Some activity is unavailable: {props.error}
      </p>
    );
  }
  if (props.pending) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Reading commit activity…
      </p>
    );
  }
  return null;
}

function PlatformSwatch(props: { platform: HubPlatform }) {
  return (
    <span
      aria-hidden
      className="size-2.5 shrink-0 rounded-sm"
      style={{ background: platformFill(props.platform) }}
    />
  );
}

function PlatformLegend(props: {
  counts: Record<HubPlatform, number>;
  hidden: ReadonlySet<HubPlatform>;
  onToggle: (platform: HubPlatform) => void;
  onShowAll: () => void;
}) {
  const present = HUB_PLATFORM_ORDER.filter((platform) => props.counts[platform] > 0);
  if (present.length === 0) return null;
  return (
    <div role="group" aria-label="Platforms" className="flex flex-wrap items-center gap-1.5">
      {present.map((platform) => (
        <Toggle
          key={platform}
          variant="outline"
          size="xs"
          pressed={!props.hidden.has(platform)}
          onPressedChange={() => props.onToggle(platform)}
          aria-label={`${HUB_PLATFORM_LABELS[platform]}, ${props.counts[platform]} projects`}
        >
          <PlatformSwatch platform={platform} />
          <span className={props.hidden.has(platform) ? "text-muted-foreground line-through" : ""}>
            {HUB_PLATFORM_LABELS[platform]}
          </span>
          <span className="tabular-nums text-muted-foreground">{props.counts[platform]}</span>
        </Toggle>
      ))}
      {props.hidden.size > 0 ? (
        <Button size="xs" variant="ghost-muted" onClick={props.onShowAll}>
          Show all
        </Button>
      ) : null}
    </div>
  );
}

function DashboardMap(props: {
  dashboard: HubDashboard;
  window: HubActivityWindow;
  nodeColors: Readonly<Record<string, ProjectIconColor>>;
  sdlcMode: HubSdlcMode;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (element === null) return;
    // The observer reports the initial size on observe.
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined) setWidth(Math.floor(next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  const height = mapHeight(width);
  const placed = useMemo(
    () => (width > 0 ? layoutDashboard(props.dashboard, width, height) : []),
    [props.dashboard, width, height],
  );
  const windowLabel = labelOf(HUB_ACTIVITY_WINDOWS, props.window);

  return (
    <div ref={setElement} className="relative w-full" style={{ height }}>
      {placed.map(({ machine, box, tiles }) => {
        const color: ProjectIconColor =
          machine.nodeName === null ? "gray" : machineColor(machine.nodeName, props.nodeColors);
        const label = machine.nodeName ?? "No checkout";
        return (
          <section
            key={machine.key}
            aria-label={`${label}, ${machine.tiles.length} projects`}
            className="absolute overflow-hidden rounded-lg border bg-card"
            style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
          >
            <div className="flex h-7.5 min-w-0 items-center gap-1.5 px-2 text-xs">
              <span
                aria-hidden
                className={`size-2 shrink-0 rounded-full bg-current ${projectIconColorClassName(color)}`}
              />
              <span className="min-w-0 truncate font-medium text-foreground">{label}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {machine.tiles.length}
                {box.width > 220 ? (machine.tiles.length === 1 ? " project" : " projects") : ""}
                {box.width > 160 ? ` · ${machine.windowCommits} in ${windowLabel}` : ""}
              </span>
            </div>
            {tiles.map(({ tile, rect }) => (
              <ProjectTile
                key={tile.key}
                tile={tile}
                rect={rect}
                machineLabel={label}
                windowLabel={windowLabel}
                stageLabel={labelOf(
                  stageOptions(props.sdlcMode),
                  stageSelectValue(tile.stage, props.sdlcMode),
                )}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function commitsLabel(tile: HubDashboardTile, windowLabel: string) {
  if (tile.windowCommits === null) return "No activity data";
  return `${tile.windowCommits} ${tile.windowCommits === 1 ? "commit" : "commits"} · ${windowLabel}`;
}

function ProjectTile(props: {
  tile: HubDashboardTile;
  rect: TreemapRect;
  machineLabel: string;
  windowLabel: string;
  stageLabel: string;
}) {
  const { tile, rect } = props;
  const showName = rect.width >= 36 && rect.height >= 20;
  const showCommits = rect.width >= 72 && rect.height >= 42;
  const showDetail = rect.width >= 110 && rect.height >= 64;
  const large = rect.width >= 180 && rect.height >= 96;
  const platformLabel = HUB_PLATFORM_LABELS[tile.platform];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to="/hub/projects/$projectId/board"
            params={{ projectId: tile.projectId }}
            aria-label={`${tile.name}, ${platformLabel}, ${commitsLabel(tile, props.windowLabel)}. Open board`}
            className="absolute flex flex-col gap-0.5 overflow-hidden rounded-md p-1.5 text-left outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            style={tileStyle(tile, rect)}
          />
        }
      >
        {showName ? (
          <span
            className={`flex min-w-0 items-center gap-1 font-semibold leading-tight ${large ? "text-sm" : "text-xs"}`}
          >
            <span className="min-w-0 truncate">{tile.name}</span>
            {tile.favorite && showCommits ? <span aria-hidden>★</span> : null}
          </span>
        ) : null}
        {showCommits ? (
          <span className="truncate text-xs tabular-nums leading-tight">
            {commitsLabel(tile, props.windowLabel)}
          </span>
        ) : null}
        {showDetail ? (
          <span className="truncate text-xs leading-tight">
            {platformLabel} · {labelOf(PRIORITY_OPTIONS, tile.priority)} · {props.stageLabel}
          </span>
        ) : null}
        {tile.running > 0 && showCommits ? (
          <span className="mt-auto flex items-center gap-1 text-xs font-medium leading-tight">
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
            {tile.running > 1 ? `${tile.running} running` : "running"}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <TileDetails tile={tile} machineLabel={props.machineLabel} stageLabel={props.stageLabel} />
      </TooltipPopup>
    </Tooltip>
  );
}

function TileDetails(props: { tile: HubDashboardTile; machineLabel: string; stageLabel: string }) {
  const { tile } = props;
  const git = tile.git;
  return (
    <div className="flex flex-col gap-1 py-0.5">
      <p className="font-semibold text-foreground">{tile.name}</p>
      <p className="flex items-center gap-1.5 text-muted-foreground">
        <PlatformSwatch platform={tile.platform} />
        {HUB_PLATFORM_LABELS[tile.platform]} · {props.machineLabel}
      </p>
      <p className="text-muted-foreground">
        {labelOf(PRIORITY_OPTIONS, tile.priority)} priority · {props.stageLabel} ·{" "}
        {labelOf(STATUS_OPTIONS, tile.status)}
        {tile.running > 0 ? ` · ${tile.running} running` : ""}
      </p>
      {tile.commits ? (
        <dl className="grid grid-cols-5 gap-x-2 tabular-nums">
          {HUB_ACTIVITY_WINDOWS.map((entry) => (
            <div key={entry.value} className="flex flex-col-reverse">
              <dt className="text-muted-foreground">{entry.label}</dt>
              <dd className="font-semibold text-foreground">{tile.commits![entry.value]}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-muted-foreground">No commit activity reported for this checkout.</p>
      )}
      {tile.lastCommitAt ? (
        <p className="text-muted-foreground">
          Last commit {formatRelativeTimeLabel(tile.lastCommitAt)}
        </p>
      ) : null}
      {git ? (
        <p className="text-muted-foreground">
          {git.branch ?? "detached"}
          {git.dirty ? " · uncommitted changes" : ""}
        </p>
      ) : null}
    </div>
  );
}

import {
  isProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
  type HubActivityWindow,
  type HubInsights,
  type HubMergedProjectView,
  type HubStrategyPriority,
} from "@t3tools/contracts";
import {
  buildHubAttention,
  defaultAttentionMetric,
  formatAgentMinutes,
  HUB_ACTIVITY_WINDOWS,
  HUB_ATTENTION_METRICS,
  localDayKey,
  type HubAttention,
  type HubAttentionMetric,
  type HubAttentionRow,
} from "@t3tools/client-runtime/codrHub/hubActivity";
import { labelOf, PRIORITY_OPTIONS } from "@t3tools/client-runtime/codrHub/hubFormat";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HubRunningBadge } from "./HubRunningBadge";
import {
  attentionChangeLabel,
  bucketHubSeries,
  HUB_PLATFORM_COLORS,
  HUB_PLATFORM_ORDER,
  type HubAttentionBar,
} from "./hubDashboardModel";

const TOP_ROWS = 10;
/** Providers past the eight palette hues share the neutral "Other" slot. */
const PROVIDER_SLOTS = 8;

const formatCount = (value: number) => value.toLocaleString();

function formatMetric(metric: HubAttentionMetric, value: number) {
  return metric === "minutes" ? formatAgentMinutes(value) : formatCount(value);
}

function providerLabel(provider: string) {
  return (
    (isProviderDriverKind(provider) ? PROVIDER_DISPLAY_NAMES[provider] : undefined) ?? provider
  );
}

/** Categorical slot from the platform palette, so provider colours follow the same validated order. */
function slotFill(index: number) {
  const colors = HUB_PLATFORM_COLORS[HUB_PLATFORM_ORDER[Math.min(index, PROVIDER_SLOTS)]!];
  return `light-dark(${colors.light}, ${colors.dark})`;
}

/** Which projects got the most agent turns, agent time, or commits in the dashboard window. */
export function HubAttentionPanel(props: {
  readonly projects: ReadonlyArray<HubMergedProjectView>;
  readonly insights: ReadonlyArray<HubInsights>;
  readonly strategy: ReadonlyArray<HubStrategyPriority>;
  readonly window: HubActivityWindow;
}) {
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00Z`);
  // null follows the data's default until the user picks a measure.
  const [pickedMetric, setMetric] = useState<HubAttentionMetric | null>(null);
  const build = (selected: HubAttentionMetric) =>
    buildHubAttention({
      projects: props.projects,
      insights: props.insights,
      strategy: props.strategy,
      window: props.window,
      metric: selected,
      today: localDayKey(new Date(nowMs)),
    });
  // Totals are the same for every metric, so the default can come from any build.
  const firstMetric = pickedMetric ?? "runs";
  const firstBuild = build(firstMetric);
  const metric = pickedMetric ?? defaultAttentionMetric(firstBuild.totals);
  const attention = metric === firstMetric ? firstBuild : build(metric);
  const windowLabel = labelOf(HUB_ACTIVITY_WINDOWS, props.window);

  return (
    <section aria-labelledby="hub-attention-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id="hub-attention-title" className="text-base font-semibold">
          Attention · {windowLabel}
        </h2>
        <ToggleGroup
          aria-label="Measure attention by"
          variant="segmented"
          value={[metric]}
          onValueChange={(next) => {
            const value = HUB_ATTENTION_METRICS.find((entry) => entry.value === next[0]);
            if (value) setMetric(value.value);
          }}
        >
          {HUB_ATTENTION_METRICS.map((entry) => (
            <ToggleGroupItem key={entry.value} value={entry.value}>
              {entry.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <StatTiles attention={attention} metric={metric} />
      {attention.series.length > 0 ? (
        <SeriesChart bars={bucketHubSeries(attention.series)} metric={metric} />
      ) : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <Ranking rows={attention.rows} metric={metric} nowMs={nowMs} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <ProviderMix providers={attention.providers} />
          <NeedsAttention neglected={attention.neglected} nowMs={nowMs} />
        </div>
      </div>
      <Footnote attention={attention} />
    </section>
  );
}

function StatTiles(props: { attention: HubAttention; metric: HubAttentionMetric }) {
  const { totals, previousTotal } = props.attention;
  const change = attentionChangeLabel(totals[props.metric], previousTotal);
  const tiles: ReadonlyArray<{ label: string; value: string; metric?: HubAttentionMetric }> = [
    { label: "Turns", value: formatCount(totals.runs), metric: "runs" },
    { label: "Agent time", value: formatAgentMinutes(totals.minutes), metric: "minutes" },
    { label: "Threads", value: formatCount(totals.threads) },
    { label: "Commits", value: formatCount(totals.commits), metric: "commits" },
    { label: "Active projects", value: formatCount(totals.activeProjects) },
    { label: "Agents running", value: formatCount(props.attention.runningCount) },
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {tiles.map((tile) => (
        <div key={tile.label} className="flex flex-col gap-0.5 rounded-lg border bg-card p-3">
          <dt className="text-xs text-muted-foreground">{tile.label}</dt>
          <dd className="text-lg font-semibold tabular-nums">{tile.value}</dd>
          {tile.metric === props.metric && change !== null ? (
            <dd className="text-xs tabular-nums text-muted-foreground">
              {change} vs previous period
            </dd>
          ) : null}
        </div>
      ))}
    </dl>
  );
}

function barRange(bar: HubAttentionBar) {
  return bar.from === bar.to ? bar.from : `${bar.from} to ${bar.to}`;
}

function SeriesChart(props: { bars: ReadonlyArray<HubAttentionBar>; metric: HubAttentionMetric }) {
  const max = props.bars.reduce((top, bar) => Math.max(top, bar[props.metric]), 0);
  const metricLabel = labelOf(HUB_ATTENTION_METRICS, props.metric);
  const weekly = props.bars.length > 0 && props.bars.at(-1)!.from !== props.bars.at(-1)!.to;
  return (
    <figure className="flex flex-col gap-2 rounded-lg border bg-card p-3">
      <figcaption className="text-xs text-muted-foreground">
        {metricLabel} per {weekly ? "week" : "day"}
        {max > 0 ? ` · peak ${formatMetric(props.metric, max)}` : ""}
      </figcaption>
      <div
        role="list"
        aria-label={`${metricLabel} over time`}
        className="flex h-28 items-end gap-px"
      >
        {props.bars.map((bar) => {
          const value = bar[props.metric];
          const label = `${barRange(bar)}: ${formatMetric(props.metric, value)}`;
          return (
            <Tooltip key={bar.from}>
              <TooltipTrigger
                render={
                  <div
                    role="listitem"
                    aria-label={label}
                    className="flex h-full min-w-0 flex-1 items-end hover:bg-accent"
                  />
                }
              >
                <div
                  className="w-full rounded-t-sm bg-primary"
                  style={{
                    height: max === 0 || value === 0 ? 0 : `${Math.max(2, (value / max) * 100)}%`,
                  }}
                />
              </TooltipTrigger>
              <TooltipPopup side="top">
                <div className="flex flex-col gap-0.5 tabular-nums">
                  <p className="font-semibold text-foreground">{barRange(bar)}</p>
                  <p className="text-muted-foreground">
                    {formatCount(bar.runs)} turns · {formatAgentMinutes(bar.minutes)} ·{" "}
                    {formatCount(bar.commits)} commits
                  </p>
                </div>
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
      <div className="flex justify-between text-xs tabular-nums text-muted-foreground">
        <span>{props.bars[0]?.from}</span>
        <span>{props.bars.at(-1)?.to}</span>
      </div>
    </figure>
  );
}

function Sparkline(props: { values: ReadonlyArray<number> }) {
  const max = props.values.reduce((top, value) => Math.max(top, value), 0);
  if (props.values.length === 0 || max === 0) return null;
  const width = 64;
  const height = 16;
  const step = width / props.values.length;
  return (
    <svg
      aria-hidden
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="text-primary"
    >
      {props.values.map((value, index) => {
        const barHeight = value === 0 ? 0 : Math.max(1, (value / max) * height);
        return (
          <rect
            // oxlint-disable-next-line react/no-array-index-key -- buckets are positional
            key={index}
            x={index * step}
            y={height - barHeight}
            width={Math.max(1, step - 0.5)}
            height={barHeight}
            fill="currentColor"
          />
        );
      })}
    </svg>
  );
}

function Ranking(props: {
  rows: ReadonlyArray<HubAttentionRow>;
  metric: HubAttentionMetric;
  nowMs: number;
}) {
  const [expanded, setExpanded] = useState(false);
  if (props.rows.length === 0) {
    return (
      <p className="rounded-lg border bg-card p-3 text-sm text-muted-foreground">
        No project had any {labelOf(HUB_ATTENTION_METRICS, props.metric).toLowerCase()} in this
        window.
      </p>
    );
  }
  const shown = expanded ? props.rows : props.rows.slice(0, TOP_ROWS);
  const untrackedNodes = new Set(
    props.rows.flatMap((row) => (row.untracked ? [row.untracked.nodeName] : [])),
  );
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-1 tabular-nums">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
            <TableHead>{labelOf(HUB_ATTENTION_METRICS, props.metric)}</TableHead>
            <TableHead>Trend</TableHead>
            <TableHead>Threads</TableHead>
            <TableHead>Commits</TableHead>
            <TableHead>Agent time</TableHead>
            <TableHead>Last active</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((row) => (
            <TableRow key={row.projectId}>
              <TableCell>
                {row.untracked ? (
                  <div className="flex min-w-0 flex-col">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="max-w-48 truncate font-medium">{row.name}</span>
                      <Badge variant="secondary" size="sm">
                        Not in Hub
                      </Badge>
                    </div>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="max-w-64 truncate text-xs text-muted-foreground" />
                        }
                      >
                        {row.untracked.workspaceRoot}
                        {untrackedNodes.size > 1 ? ` · ${row.untracked.nodeName}` : ""}
                      </TooltipTrigger>
                      <TooltipPopup side="top">{row.untracked.workspaceRoot}</TooltipPopup>
                    </Tooltip>
                  </div>
                ) : (
                  <div className="flex min-w-0 items-center gap-2">
                    <Link
                      to="/hub/projects/$projectId/board"
                      params={{ projectId: row.projectId }}
                      className="max-w-48 truncate font-medium hover:underline"
                    >
                      {row.name}
                    </Link>
                    {row.running > 0 ? <HubRunningBadge count={row.running} /> : null}
                  </div>
                )}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <span className="w-14 tabular-nums">{formatMetric(props.metric, row.value)}</span>
                  <span
                    aria-label={`${Math.round(row.share * 100)}% of total`}
                    className="h-1.5 w-16 overflow-hidden rounded-full bg-muted"
                  >
                    <span
                      className="block h-full rounded-full bg-primary"
                      style={{ width: `${row.share * 100}%` }}
                    />
                  </span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Sparkline values={row.spark} />
                  <span className="tabular-nums text-muted-foreground">
                    {attentionChangeLabel(row.value, row.previous) ?? ""}
                  </span>
                </div>
              </TableCell>
              <TableCell>{formatCount(row.threads)}</TableCell>
              <TableCell>{formatCount(row.commits)}</TableCell>
              <TableCell>{formatAgentMinutes(row.minutes)}</TableCell>
              <TableCell>
                <span className="text-muted-foreground">
                  {row.lastActiveAt ? formatRelativeTimeLabel(row.lastActiveAt, props.nowMs) : ""}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {props.rows.length > TOP_ROWS ? (
        <div className="px-1 pb-1">
          <Button size="xs" variant="ghost-muted" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Show top 10" : `Show all ${props.rows.length}`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ProviderMix(props: { providers: HubAttention["providers"] }) {
  const total = props.providers.reduce((sum, entry) => sum + entry.runs, 0);
  if (total === 0) return null;
  const named = props.providers.slice(0, PROVIDER_SLOTS);
  const otherRuns = props.providers.slice(PROVIDER_SLOTS).reduce((sum, e) => sum + e.runs, 0);
  const segments = [
    ...named.map((entry, index) => ({
      key: entry.provider,
      label: providerLabel(entry.provider),
      runs: entry.runs,
      fill: slotFill(index),
    })),
    ...(otherRuns > 0
      ? [{ key: "\u0000other", label: "Other", runs: otherRuns, fill: slotFill(PROVIDER_SLOTS) }]
      : []),
  ];
  return (
    <section
      aria-label="Provider mix"
      className="flex flex-col gap-2 rounded-lg border bg-card p-3"
    >
      <h3 className="text-xs text-muted-foreground">Turns by provider</h3>
      <div aria-hidden className="flex h-2.5 gap-px overflow-hidden rounded-full">
        {segments.map((segment) => (
          <span
            key={segment.key}
            style={{ width: `${(segment.runs / total) * 100}%`, background: segment.fill }}
          />
        ))}
      </div>
      <ul className="flex flex-col gap-1 text-xs">
        {segments.map((segment) => (
          <li key={segment.key} className="flex items-center gap-2">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-sm"
              style={{ background: segment.fill }}
            />
            <span className="min-w-0 flex-1 truncate">{segment.label}</span>
            <span className="tabular-nums text-muted-foreground">
              {formatCount(segment.runs)} · {Math.round((segment.runs / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NeedsAttention(props: { neglected: HubAttention["neglected"]; nowMs: number }) {
  if (props.neglected.length === 0) return null;
  return (
    <section
      aria-label="Needs attention"
      className="flex flex-col gap-2 rounded-lg border bg-card p-3"
    >
      <h3 className="text-xs text-muted-foreground">
        Needs attention · important projects with no turns or commits
      </h3>
      <ul className="flex flex-col gap-1.5 text-sm">
        {props.neglected.map((entry) => (
          <li key={entry.projectId} className="flex min-w-0 flex-col">
            <Link
              to="/hub/projects/$projectId/board"
              params={{ projectId: entry.projectId }}
              className="truncate font-medium hover:underline"
            >
              {entry.name}
            </Link>
            <span className="text-xs text-muted-foreground">
              {[
                entry.priority === "none"
                  ? null
                  : `${labelOf(PRIORITY_OPTIONS, entry.priority)} priority`,
                entry.onStrategy ? "on strategy" : null,
                entry.lastActiveAt
                  ? `last active ${formatRelativeTimeLabel(entry.lastActiveAt, props.nowMs)}`
                  : "never active",
              ]
                .filter((part) => part !== null)
                .join(" · ")}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Footnote(props: { attention: HubAttention }) {
  const { quietCount, unreportedCount } = props.attention;
  const parts = [
    quietCount > 0 ? `${quietCount} quiet ${quietCount === 1 ? "project" : "projects"}` : null,
    unreportedCount > 0 ? `${unreportedCount} not reported by a connected machine` : null,
  ].filter((part) => part !== null);
  if (parts.length === 0) return null;
  return <p className="text-xs text-muted-foreground">{parts.join(" · ")}.</p>;
}

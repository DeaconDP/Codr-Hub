import {
  buildHubAttention,
  defaultAttentionMetric,
  formatAgentMinutes,
  HUB_ACTIVITY_WINDOWS,
  HUB_ATTENTION_METRICS,
  localDayKey,
  type HubAttentionDay,
  type HubAttentionMetric,
} from "@t3tools/client-runtime/codrHub/hubActivity";
import { labelOf, PRIORITY_OPTIONS } from "@t3tools/client-runtime/codrHub/hubFormat";
import {
  PROVIDER_DISPLAY_NAMES,
  type HubActivityWindow,
  type HubStrategyPriority,
} from "@t3tools/contracts";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, RefreshControl, ScrollView as HorizontalScrollView, View } from "react-native";

import { ProviderIcon } from "../../components/ProviderIcon";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { relativeTime } from "../../lib/time";
import { useHubInsights, type useHubPortfolio } from "./useHubPortfolio";
import { hubThreadActionLabel, useStartHubThread } from "./useStartHubThread";

type Portfolio = ReturnType<typeof useHubPortfolio>;

const NO_STRATEGY: ReadonlyArray<HubStrategyPriority> = [];
const MAX_CHART_BARS = 60;
const METRIC_NOUN: Record<HubAttentionMetric, string> = {
  runs: "turns",
  minutes: "agent time",
  commits: "commits",
};
const PROVIDER_NAMES: Partial<Record<string, string>> = PROVIDER_DISPLAY_NAMES;

const formatMetric = (metric: HubAttentionMetric, value: number) =>
  metric === "minutes" ? formatAgentMinutes(value) : value.toLocaleString();

function changeLabel(current: number, previous: number, windowLabel: string): string | null {
  if (current === 0 && previous === 0) return null;
  if (previous === 0) return `up from none, prev ${windowLabel}`;
  const percent = Math.round(((current - previous) / previous) * 100);
  if (percent === 0) return `same as prev ${windowLabel}`;
  return `${percent > 0 ? "+" : ""}${percent}% vs prev ${windowLabel}`;
}

/** Sums days into at most `max` bars, oldest first. */
function chartBars(
  series: ReadonlyArray<HubAttentionDay>,
  metric: HubAttentionMetric,
  max: number,
) {
  const size = Math.max(1, Math.ceil(series.length / max));
  const bars: number[] = [];
  for (let index = 0; index < series.length; index += size) {
    let total = 0;
    for (const day of series.slice(index, index + size)) total += day[metric];
    bars.push(total);
  }
  return bars;
}

function dayLabel(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year!, month! - 1, date!).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Which projects got the most agent turns, agent time or commits in a window, and which got none. */
export function HubOverviewView(props: {
  portfolio: Portfolio;
  bottomInset: number;
  header: ReactNode;
}) {
  const { portfolio } = props;
  const insights = useHubInsights();
  const startThread = useStartHubThread(portfolio.nodeNameByEnvironmentId);
  const [activityWindow, setActivityWindow] = useState<HubActivityWindow>("7d");
  // null follows the data's default until the user picks a measure.
  const [pickedMetric, setMetric] = useState<HubAttentionMetric | null>(null);
  const nowMs = useNowMinuteMs();
  const today = localDayKey(new Date(nowMs));
  const strategy = portfolio.anySnapshot?.strategy ?? NO_STRATEGY;
  const { attention, metric } = useMemo(() => {
    const build = (selected: HubAttentionMetric) =>
      buildHubAttention({
        projects: portfolio.projects,
        insights: insights.insights,
        strategy,
        window: activityWindow,
        metric: selected,
        today,
      });
    // Totals are the same for every metric, so the default can come from any build.
    const first = pickedMetric ?? "runs";
    const built = build(first);
    const effective = pickedMetric ?? defaultAttentionMetric(built.totals);
    return { attention: effective === first ? built : build(effective), metric: effective };
  }, [portfolio.projects, insights.insights, strategy, activityWindow, pickedMetric, today]);
  const viewById = new Map(portfolio.projects.map((view) => [view.project.id, view]));
  const untrackedNodes = new Set(
    attention.rows.flatMap((row) => (row.untracked ? [row.untracked.nodeName] : [])),
  );
  const windowLabel = labelOf(HUB_ACTIVITY_WINDOWS, activityWindow);
  const metricNoun = METRIC_NOUN[metric];
  const { totals } = attention;
  const change =
    attention.previousTotal === null
      ? null
      : changeLabel(totals[metric], attention.previousTotal, windowLabel);
  const notes = [
    attention.quietCount > 0 ? `${attention.quietCount} quiet` : null,
    attention.unreportedCount > 0
      ? `${attention.unreportedCount} not on a connected machine`
      : null,
  ].filter((note) => note !== null);
  const loading = insights.isPending && insights.insights.length === 0;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      className="flex-1"
      contentContainerClassName="gap-5 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(props.bottomInset, 18) + 18 }}
      refreshControl={
        <RefreshControl refreshing={insights.isPending} onRefresh={insights.refresh} />
      }
    >
      {props.header}
      <View className="gap-3">
        <HorizontalScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="-mx-5"
          contentContainerClassName="gap-2 px-5"
          accessibilityRole="tablist"
        >
          {HUB_ACTIVITY_WINDOWS.map((option) => (
            <Chip
              key={option.value}
              label={option.label}
              selected={option.value === activityWindow}
              onPress={() => setActivityWindow(option.value)}
              accessibilityLabel={`Window ${option.label}`}
            />
          ))}
        </HorizontalScrollView>
        <SegmentedControl
          options={HUB_ATTENTION_METRICS}
          selected={metric}
          onSelect={setMetric}
          size="compact"
        />
      </View>
      {loading ? (
        <View className="items-center py-8" accessibilityLabel="Loading activity">
          <AppActivityIndicator colorClassName="accent-icon-muted" />
        </View>
      ) : (
        <>
          <View className="gap-3">
            <View className="flex-row gap-3">
              <Stat
                label={`Turns · ${windowLabel}`}
                value={totals.runs.toLocaleString()}
                detail={metric === "runs" ? change : null}
              />
              <Stat
                label="Agent time"
                value={formatAgentMinutes(totals.minutes)}
                detail={metric === "minutes" ? change : null}
              />
              <Stat label="Threads" value={totals.threads.toLocaleString()} />
            </View>
            <View className="flex-row gap-3">
              <Stat
                label="Commits"
                value={totals.commits.toLocaleString()}
                detail={metric === "commits" ? change : null}
              />
              <Stat label="Active projects" value={totals.activeProjects.toLocaleString()} />
              <Stat label="Agents running" value={attention.runningCount.toLocaleString()} />
            </View>
          </View>
          {attention.series.length > 0 ? (
            <DailyChart series={attention.series} metric={metric} windowLabel={windowLabel} />
          ) : null}
          {attention.rows.length === 0 ? (
            <EmptyState
              variant="plain"
              title={`No ${metricNoun} in ${windowLabel}`}
              detail="Try a longer window or another measure."
            />
          ) : (
            <Section title={`Most attention · ${metricNoun}`}>
              <View collapsable={false} className="overflow-hidden rounded-[24px] bg-grouped-card">
                {attention.rows.map((row, index) => {
                  const view = row.untracked ? undefined : viewById.get(row.projectId);
                  const target = view ? startThread.targetFor(view) : null;
                  const folder = row.untracked
                    ? untrackedNodes.size > 1
                      ? `${row.untracked.workspaceRoot} · ${row.untracked.nodeName}`
                      : row.untracked.workspaceRoot
                    : null;
                  const valueLabel = formatMetric(metric, row.value);
                  const trend =
                    row.previous === null || row.previous === row.value
                      ? null
                      : row.value > row.previous
                        ? "up"
                        : "down";
                  const meta = [
                    row.running > 0 ? `${row.running} running` : null,
                    row.lastActiveAt ? `${relativeTime(row.lastActiveAt, nowMs)} ago` : null,
                    `${Math.round(row.share * 100)}%`,
                  ].filter((part) => part !== null);
                  return (
                    <Pressable
                      key={row.projectId}
                      accessibilityRole={view ? "button" : undefined}
                      accessibilityLabel={[
                        row.name,
                        folder ? `Not in Hub, ${folder}` : null,
                        `${valueLabel} ${metric === "minutes" ? "" : metricNoun}`.trim(),
                        trend === null ? null : trend === "up" ? "trending up" : "trending down",
                        ...meta,
                        target ? hubThreadActionLabel(target) : null,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                      disabled={!view}
                      onPress={view && target ? () => startThread.start(view, target) : undefined}
                      className={cn(
                        "gap-1.5 bg-grouped-card px-4 py-3",
                        index > 0 && "border-t border-border-subtle",
                      )}
                    >
                      <View className="flex-row items-center gap-2">
                        {row.running > 0 ? (
                          <View className="size-2 rounded-full bg-primary" />
                        ) : null}
                        <Text className="min-w-0 flex-1 text-sm font-t3-bold" numberOfLines={1}>
                          {row.name}
                        </Text>
                        {row.untracked ? (
                          <View className="rounded-md bg-subtle px-1.5 py-0.5">
                            <Text className="text-3xs font-t3-bold text-foreground-muted">
                              Not in Hub
                            </Text>
                          </View>
                        ) : null}
                        {trend ? (
                          <SymbolView
                            name={trend === "up" ? "arrow.up" : "arrow.down"}
                            size={11}
                            tintColorClassName="accent-icon-subtle"
                            type="monochrome"
                          />
                        ) : null}
                        <Text className="text-sm font-t3-bold">{valueLabel}</Text>
                      </View>
                      {folder ? (
                        <Text
                          className="text-xs text-foreground-muted"
                          numberOfLines={1}
                          ellipsizeMode="middle"
                        >
                          {folder}
                        </Text>
                      ) : null}
                      <View className="h-1 rounded-full bg-subtle-strong">
                        <View
                          className="h-1 rounded-full bg-primary"
                          style={{ width: `${Math.max(2, row.share * 100)}%` }}
                        />
                      </View>
                      <View className="flex-row items-center gap-3">
                        <Text
                          className="min-w-0 flex-1 text-xs text-foreground-muted"
                          numberOfLines={1}
                        >
                          {meta.join(" · ")}
                        </Text>
                        {row.spark.length > 1 ? <Sparkline values={row.spark} /> : null}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            </Section>
          )}
          {attention.providers.length > 0 ? (
            <ProviderMix providers={attention.providers} total={totals.runs} />
          ) : null}
          {attention.neglected.length > 0 ? (
            <Section title={`Needs attention · ${attention.neglected.length}`}>
              <View collapsable={false} className="overflow-hidden rounded-[24px] bg-grouped-card">
                {attention.neglected.map((entry, index) => {
                  const view = viewById.get(entry.projectId);
                  const target = view ? startThread.targetFor(view) : null;
                  const badges = [
                    entry.priority === "none" ? null : labelOf(PRIORITY_OPTIONS, entry.priority),
                    entry.onStrategy ? "On strategy" : null,
                    entry.lastActiveAt
                      ? `last active ${relativeTime(entry.lastActiveAt, nowMs)} ago`
                      : "no activity yet",
                  ].filter((part) => part !== null);
                  return (
                    <Pressable
                      key={entry.projectId}
                      accessibilityRole={view ? "button" : undefined}
                      accessibilityLabel={[
                        entry.name,
                        ...badges,
                        target ? hubThreadActionLabel(target) : null,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                      disabled={!view}
                      onPress={view && target ? () => startThread.start(view, target) : undefined}
                      className={cn(
                        "flex-row items-center gap-3 bg-grouped-card px-4 py-3",
                        index > 0 && "border-t border-border-subtle",
                      )}
                    >
                      <SymbolView
                        name="exclamationmark.circle"
                        size={18}
                        tintColorClassName="accent-icon-subtle"
                        type="monochrome"
                      />
                      <View className="min-w-0 flex-1">
                        <Text className="text-sm font-t3-bold leading-snug" numberOfLines={1}>
                          {entry.name}
                        </Text>
                        <Text
                          className="text-xs leading-snug text-foreground-muted"
                          numberOfLines={1}
                        >
                          {badges.join(" · ")}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            </Section>
          ) : null}
          {insights.error !== null ? (
            <Text className="text-xs leading-normal text-foreground-muted">
              Some activity is unavailable: {insights.error}
            </Text>
          ) : null}
          {notes.length > 0 ? (
            <Text className="text-center text-xs text-foreground-muted">{notes.join(" · ")}</Text>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <View className="gap-2">
      <Text
        accessibilityRole="header"
        className="px-1 text-2xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted"
      >
        {props.title}
      </Text>
      {props.children}
    </View>
  );
}

function Stat(props: { label: string; value: string; detail?: string | null }) {
  return (
    <View
      className="min-w-0 flex-1 gap-1 rounded-[20px] bg-grouped-card p-3"
      accessible
      accessibilityLabel={[`${props.label}: ${props.value}`, props.detail]
        .filter(Boolean)
        .join(", ")}
    >
      <Text className="text-xl font-t3-bold" numberOfLines={1} adjustsFontSizeToFit>
        {props.value}
      </Text>
      <Text className="text-xs leading-snug text-foreground-muted" numberOfLines={2}>
        {props.label}
      </Text>
      {props.detail ? (
        <Text className="text-2xs leading-snug text-foreground-muted" numberOfLines={2}>
          {props.detail}
        </Text>
      ) : null}
    </View>
  );
}

function DailyChart(props: {
  series: ReadonlyArray<HubAttentionDay>;
  metric: HubAttentionMetric;
  windowLabel: string;
}) {
  const bars = chartBars(props.series, props.metric, MAX_CHART_BARS);
  const peak = bars.reduce((max, value) => Math.max(max, value), 0);
  const first = props.series[0]!.day;
  return (
    <View
      className="gap-2 rounded-[24px] bg-grouped-card p-4"
      accessible
      accessibilityLabel={`Daily ${METRIC_NOUN[props.metric]}, ${props.windowLabel}, peak ${formatMetric(props.metric, peak)}`}
    >
      <View className="flex-row items-baseline">
        <Text className="min-w-0 flex-1 text-xs font-t3-bold text-foreground-muted">
          {bars.length === props.series.length ? "Per day" : "Per period"}
        </Text>
        <Text className="text-xs text-foreground-muted">
          peak {formatMetric(props.metric, peak)}
        </Text>
      </View>
      <View className="h-20 flex-row items-end gap-px">
        {bars.map((value, index) => (
          <View
            // oxlint-disable-next-line react/no-array-index-key -- bars are positional buckets
            key={index}
            className={cn("flex-1 rounded-t-sm", value > 0 ? "bg-primary" : "bg-subtle-strong")}
            style={{ height: value > 0 && peak > 0 ? `${Math.max(4, (value / peak) * 100)}%` : 1 }}
          />
        ))}
      </View>
      <View className="flex-row">
        <Text className="min-w-0 flex-1 text-2xs text-foreground-muted">{dayLabel(first)}</Text>
        <Text className="text-2xs text-foreground-muted">Today</Text>
      </View>
    </View>
  );
}

function Sparkline(props: { values: ReadonlyArray<number> }) {
  const peak = props.values.reduce((max, value) => Math.max(max, value), 0);
  return (
    <View
      className="h-4 w-16 flex-row items-end gap-px"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {props.values.map((value, index) => (
        <View
          // oxlint-disable-next-line react/no-array-index-key -- bars are positional buckets
          key={index}
          className={cn("flex-1 rounded-t-sm", value > 0 ? "bg-primary" : "bg-subtle-strong")}
          style={{ height: value > 0 && peak > 0 ? `${Math.max(12, (value / peak) * 100)}%` : 1 }}
        />
      ))}
    </View>
  );
}

function ProviderMix(props: {
  providers: ReadonlyArray<{ provider: string; runs: number }>;
  total: number;
}) {
  return (
    <Section title="Agents used · turns">
      <View className="gap-3 rounded-[24px] bg-grouped-card p-4">
        {props.providers.map((entry) => {
          const name = PROVIDER_NAMES[entry.provider] ?? entry.provider;
          const share = props.total === 0 ? 0 : entry.runs / props.total;
          return (
            <View
              key={entry.provider}
              className="gap-1.5"
              accessible
              accessibilityLabel={`${name}, ${entry.runs} ${entry.runs === 1 ? "turn" : "turns"}, ${Math.round(share * 100)}%`}
            >
              <View className="flex-row items-center gap-2">
                <ProviderIcon provider={entry.provider} size={16} />
                <Text className="min-w-0 flex-1 text-sm font-t3-bold" numberOfLines={1}>
                  {name}
                </Text>
                <Text className="text-xs text-foreground-muted">{Math.round(share * 100)}%</Text>
                <Text className="text-sm font-t3-bold">{entry.runs.toLocaleString()}</Text>
              </View>
              <View className="h-1 rounded-full bg-subtle-strong">
                <View
                  className="h-1 rounded-full bg-primary"
                  style={{ width: `${Math.max(2, share * 100)}%` }}
                />
              </View>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

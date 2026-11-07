import {
  filterAndSortProjects,
  labelOf,
  PRIORITY_OPTIONS,
  projectGlance,
  SORT_OPTIONS,
  type HubProjectSort,
} from "@t3tools/client-runtime/codrHub/hubFormat";
import { needsAttention, projectScanChips } from "@t3tools/client-runtime/codrHub/scanAttention";
import type { HubMergedProjectView } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { cn } from "../../lib/cn";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { HubBuildStamp } from "./HubBuildStamp";
import { hubProjectMenuActions, hubProjectPatchForAction } from "./hubProjectMenu";
import { HubOverviewView } from "./HubOverviewView";
import { HubMachinePace } from "./HubPaceView";
import { HubStagesView } from "./HubStagesView";
import { useConnectedHubMachines, useHubPortfolio } from "./useHubPortfolio";
import { useHubProjectEdits } from "./useHubProjectEdits";
import { hubThreadActionLabel, useStartHubThread } from "./useStartHubThread";

type HubView = "ranked" | "stages" | "favorites" | "overview" | "pace";
const VIEW_OPTIONS = [
  { value: "ranked", label: "Ranked" },
  { value: "stages", label: "Stages" },
  { value: "favorites", label: "Favourites" },
  { value: "overview", label: "Overview" },
  { value: "pace", label: "Pace" },
] as const satisfies readonly { value: HubView; label: string }[];

type Portfolio = ReturnType<typeof useHubPortfolio>;

export function HubRouteScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const portfolio = useHubPortfolio();
  const machines = useConnectedHubMachines();
  const [view, setView] = useState<HubView>("ranked");
  const [sort, setSort] = useState<HubProjectSort>("rank");
  const hasPortfolio = portfolio.anySnapshot !== null;

  return (
    <SettingsScreen title="Hub" workspaceRoot>
      {portfolio.connectedCount === 0 && !hasPortfolio ? (
        <HubScroll bottomInset={insets.bottom}>
          <EmptyState
            variant="plain"
            title="No environments connected"
            detail="Connect a machine running Codr-Hub to see your projects."
            actionLabel="Add environment"
            onAction={() => navigation.navigate("ConnectionsNew")}
          />
        </HubScroll>
      ) : !hasPortfolio && portfolio.error !== null && !portfolio.isPending ? (
        <HubScroll bottomInset={insets.bottom}>
          <EmptyState
            variant="plain"
            title="Hub isn't available"
            detail={`None of your connected machines (${machines.map((machine) => machine.label).join(", ")}) runs Codr-Hub. T3 Code servers don't include the Hub, so add a connection to a machine running Codr-Hub.`}
            actionLabel="Add environment"
            onAction={() => navigation.navigate("ConnectionsNew")}
          />
        </HubScroll>
      ) : !hasPortfolio ? (
        <HubScroll bottomInset={insets.bottom}>
          <View className="items-center py-8" accessibilityLabel="Loading Hub">
            <AppActivityIndicator colorClassName="accent-icon-muted" />
          </View>
        </HubScroll>
      ) : portfolio.projects.length === 0 ? (
        <HubScroll bottomInset={insets.bottom}>
          <EmptyState
            variant="plain"
            title="No projects yet"
            detail="Import your projects from Hub in the web app, or turn on Sync with T3 there."
          />
        </HubScroll>
      ) : view === "pace" ? (
        <HubScroll bottomInset={insets.bottom}>
          <ViewPicker view={view} onSelect={setView} />
          {machines.map((machine) => (
            <HubMachinePace key={machine.environmentId} {...machine} />
          ))}
        </HubScroll>
      ) : view === "stages" ? (
        <HubStagesView
          portfolio={portfolio}
          bottomInset={insets.bottom}
          header={<ViewPicker view={view} onSelect={setView} />}
        />
      ) : view === "overview" ? (
        <HubOverviewView
          portfolio={portfolio}
          bottomInset={insets.bottom}
          header={<ViewPicker view={view} onSelect={setView} />}
        />
      ) : (
        <HubScroll bottomInset={insets.bottom}>
          <ViewPicker view={view} onSelect={setView} />
          <ProjectList
            portfolio={portfolio}
            favoritesOnly={view === "favorites"}
            sort={sort}
            onSort={setSort}
          />
        </HubScroll>
      )}
    </SettingsScreen>
  );
}

/** Inset-adjusted so content starts below the native large-title header. */
function HubScroll(props: { bottomInset: number; children: ReactNode }) {
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      className="flex-1"
      contentContainerClassName="gap-5 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(props.bottomInset, 18) + 18 }}
    >
      {props.children}
    </ScrollView>
  );
}

function ViewPicker(props: { view: HubView; onSelect: (view: HubView) => void }) {
  return (
    <View className="gap-2">
      <SegmentedControl
        options={VIEW_OPTIONS}
        selected={props.view}
        onSelect={props.onSelect}
        role="tab"
      />
      <HubBuildStamp />
    </View>
  );
}

function ProjectList(props: {
  portfolio: Portfolio;
  favoritesOnly: boolean;
  sort: HubProjectSort;
  onSort: (sort: HubProjectSort) => void;
}) {
  const { portfolio, favoritesOnly, sort } = props;
  const snapshot = portfolio.anySnapshot!;
  const startThread = useStartHubThread(portfolio.nodeNameByEnvironmentId);
  const { projects, editProject } = useHubProjectEdits(portfolio);
  const [showFinished, setShowFinished] = useState(false);
  const [attentionOnly, setAttentionOnly] = useState(false);

  const sorted = (filter: "open" | "all", by: HubProjectSort) =>
    filterAndSortProjects(projects, { filter, sort: by, query: "", strategy: snapshot.strategy });
  const isFinished = ({ project }: HubMergedProjectView) =>
    project.archived || project.status === "done";
  const finished = sorted("all", sort).filter(isFinished);
  // Rank is the open portfolio's, so a project keeps its number in every list and sort, and
  // showing finished work never renumbers it.
  const rankById = new Map(
    sorted("open", "rank").map((view, index) => [view.project.id, index + 1]),
  );
  const rows = [
    ...sorted("open", sort).map((view) => ({ view, rank: rankById.get(view.project.id) ?? null })),
    ...(showFinished ? finished.map((view) => ({ view, rank: null })) : []),
  ].filter((row) => !favoritesOnly || row.view.project.favorite);
  const attentionRows = sorted("all", sort)
    .filter((view) => needsAttention(view.project))
    .filter((view) => !favoritesOnly || view.project.favorite)
    .map((view) => ({ view, rank: rankById.get(view.project.id) ?? null }));
  const shown = attentionOnly ? attentionRows : rows;

  if (rows.length === 0 && attentionRows.length === 0) {
    return (
      <EmptyState
        variant="plain"
        title={favoritesOnly ? "No favourites yet" : "Nothing open"}
        detail={
          favoritesOnly
            ? "Tap the star on a project in Ranked to keep it here."
            : "Every project is done or archived."
        }
      />
    );
  }

  return (
    <View className="gap-3">
      <View className="flex-row items-center justify-between">
        {attentionRows.length > 0 || attentionOnly ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: attentionOnly }}
            onPress={() => setAttentionOnly((current) => !current)}
            className="min-h-11 justify-center px-1"
          >
            <Text
              className={cn(
                "text-sm",
                attentionOnly ? "font-t3-bold text-foreground" : "text-foreground-muted",
              )}
            >
              {attentionOnly ? "Show all" : `Attention (${attentionRows.length})`}
            </Text>
          </Pressable>
        ) : (
          <View />
        )}
        <Menu
          title="Sort by"
          actions={SORT_OPTIONS.map((option) => ({
            id: option.value,
            title: option.label,
            state: option.value === sort ? "on" : "off",
          }))}
          onPressAction={({ nativeEvent }) => {
            const next = SORT_OPTIONS.find((option) => option.value === nativeEvent.event);
            if (next) props.onSort(next.value);
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Sort by ${labelOf(SORT_OPTIONS, sort)}`}
            className="min-h-11 flex-row items-center gap-1.5 px-1"
          >
            <Text className="text-sm text-foreground-muted">
              Sort: {labelOf(SORT_OPTIONS, sort)}
            </Text>
            <SymbolView
              name="chevron.down"
              size={12}
              tintColorClassName="accent-icon-subtle"
              type="monochrome"
            />
          </Pressable>
        </Menu>
      </View>
      <View collapsable={false} className="overflow-hidden rounded-[24px] bg-grouped-card">
        {shown.map(({ view, rank }, index) => {
          const threadTarget = startThread.targetFor(view);
          const priority =
            view.project.priority === "none"
              ? null
              : labelOf(PRIORITY_OPTIONS, view.project.priority);
          const glance = projectGlance({
            project: view.project,
            nodes: view.nodes,
            selectedNodeName:
              (threadTarget.kind === "open"
                ? portfolio.nodeNameByEnvironmentId.get(threadTarget.project.environmentId)
                : undefined) ?? snapshot.nodeName,
            strategy: snapshot.strategy,
            mode: snapshot.settings.sdlcMode,
          });
          return (
            <View
              key={view.project.id}
              className={cn(
                "flex-row items-center bg-grouped-card",
                index > 0 && "border-t border-border-subtle",
              )}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${rank === null ? "Finished" : rank}, ${view.project.name}, ${hubThreadActionLabel(threadTarget)}`}
                onPress={() => startThread.start(view, threadTarget)}
                className="min-w-0 flex-1 flex-row items-center gap-3 py-3 ps-4"
              >
                <Text className="w-6 text-center text-sm font-t3-bold text-foreground-muted">
                  {rank ?? "–"}
                </Text>
                <View className="min-w-0 flex-1">
                  <Text className="text-base font-t3-bold leading-snug" numberOfLines={1}>
                    {view.project.name}
                  </Text>
                  <Text className="text-xs leading-snug text-foreground-muted" numberOfLines={1}>
                    {[priority, glance].filter(Boolean).join(" · ")}
                  </Text>
                  <ScanFlags view={view} />
                </View>
              </Pressable>
              <Menu
                title={view.project.name}
                actions={hubProjectMenuActions(
                  view.project,
                  snapshot.strategy,
                  snapshot.settings.sdlcMode,
                )}
                onPressAction={({ nativeEvent }) => {
                  const edit = hubProjectPatchForAction(
                    nativeEvent.event,
                    snapshot.settings.sdlcMode,
                  );
                  if (edit) void editProject(view, edit);
                }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Edit ${view.project.name}`}
                  className="size-11 items-center justify-center"
                >
                  <SymbolView
                    name="ellipsis.circle"
                    size={20}
                    tintColorClassName="accent-icon-subtle"
                    type="monochrome"
                  />
                </Pressable>
              </Menu>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  view.project.favorite
                    ? `Remove ${view.project.name} from favourites`
                    : `Add ${view.project.name} to favourites`
                }
                accessibilityState={{ selected: view.project.favorite }}
                onPress={() => void editProject(view, { favorite: !view.project.favorite })}
                className="size-12 items-center justify-center"
              >
                <SymbolView
                  name={view.project.favorite ? "star.fill" : "star"}
                  size={20}
                  tintColorClassName={
                    view.project.favorite ? "accent-foreground" : "accent-icon-subtle"
                  }
                  type="monochrome"
                />
              </Pressable>
            </View>
          );
        })}
      </View>
      {!favoritesOnly && !attentionOnly && finished.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setShowFinished((current) => !current)}
          className="min-h-11 items-center justify-center"
        >
          <Text className="text-sm text-foreground-muted">
            {showFinished ? "Hide finished" : `Show ${finished.length} finished`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const FLAG_TEXT = {
  danger: "text-danger-foreground",
  warning: "text-warning-foreground",
  muted: "text-foreground-muted",
} as const;

function ScanFlags(props: { view: HubMergedProjectView }) {
  const chips = projectScanChips(props.view.project);
  if (chips.length === 0) return null;
  return (
    <Text className="text-xs leading-snug" numberOfLines={1}>
      {chips.map((chip, index) => (
        <Text key={chip.label} className={FLAG_TEXT[chip.tone]}>
          {index > 0 ? " · " : ""}
          {chip.label}
        </Text>
      ))}
    </Text>
  );
}

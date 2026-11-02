import {
  buildHubActivity,
  HUB_ACTIVITY_WINDOWS,
} from "@t3tools/client-runtime/codrHub/hubActivity";
import {
  filterAndSortProjects,
  labelOf,
  PRIORITY_OPTIONS,
  projectGlance,
} from "@t3tools/client-runtime/codrHub/hubFormat";
import {
  hubWriteEnvironment,
  t3ProjectForHubView,
} from "@t3tools/client-runtime/codrHub/projectPickerModel";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { HubActivityWindow, HubMergedProjectView } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useState, type ReactNode } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { useSelectWorkspaceTab } from "../workspace/useSelectWorkspaceTab";
import {
  hubProjectMenuActions,
  hubProjectPatchForAction,
  type HubProjectPatch,
} from "./hubProjectMenu";
import { useHubInsights, useHubPortfolio } from "./useHubPortfolio";

type HubView = "ranked" | "favorites" | "activity";
const VIEW_OPTIONS = [
  { value: "ranked", label: "Ranked" },
  { value: "favorites", label: "Favourites" },
  { value: "activity", label: "Activity" },
] as const satisfies readonly { value: HubView; label: string }[];

type Portfolio = ReturnType<typeof useHubPortfolio>;

export function HubRouteScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const portfolio = useHubPortfolio();
  const [view, setView] = useState<HubView>("ranked");
  const hasPortfolio = portfolio.anySnapshot !== null;

  return (
    <SettingsScreen title="Hub" workspaceRoot>
      {portfolio.connectedCount === 0 ? (
        <EmptyState
          variant="plain"
          title="No environments connected"
          detail="Connect a machine running Codr-Hub to see your projects."
          actionLabel="Add environment"
          onAction={() => navigation.navigate("ConnectionsNew")}
        />
      ) : !hasPortfolio && portfolio.error !== null && !portfolio.isPending ? (
        <EmptyState
          variant="plain"
          title="Hub isn't available"
          detail={`The connected environments need to run Codr-Hub. T3 Code servers don't include the Hub. ${portfolio.error}`}
        />
      ) : !hasPortfolio ? (
        <View className="flex-1 items-center justify-center" accessibilityLabel="Loading Hub">
          <AppActivityIndicator colorClassName="accent-icon-muted" />
        </View>
      ) : portfolio.projects.length === 0 ? (
        <EmptyState
          variant="plain"
          title="No projects yet"
          detail="Import your projects from Hub in the web app, or turn on Sync with T3 there."
        />
      ) : view === "activity" ? (
        <ActivityView
          portfolio={portfolio}
          bottomInset={insets.bottom}
          header={<ViewPicker view={view} onSelect={setView} />}
        />
      ) : (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-5 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <ViewPicker view={view} onSelect={setView} />
          <ProjectList portfolio={portfolio} favoritesOnly={view === "favorites"} />
        </ScrollView>
      )}
    </SettingsScreen>
  );
}

function ViewPicker(props: { view: HubView; onSelect: (view: HubView) => void }) {
  return (
    <SegmentedControl
      options={VIEW_OPTIONS}
      selected={props.view}
      onSelect={props.onSelect}
      role="tab"
    />
  );
}

function ProjectList(props: { portfolio: Portfolio; favoritesOnly: boolean }) {
  const { portfolio, favoritesOnly } = props;
  const snapshot = portfolio.anySnapshot!;
  const t3Projects = useProjects();
  const selectDetail = useSelectWorkspaceDetail();
  const selectTab = useSelectWorkspaceTab();
  const upsertProject = useAtomCommand(serverEnvironment.hubUpsertProject, {
    reportFailure: false,
  });
  // Saving commits to the portfolio repo, so show an edit before the snapshot catches up.
  const [pendingEdits, setPendingEdits] = useState<ReadonlyMap<string, HubProjectPatch>>(new Map());
  const [showFinished, setShowFinished] = useState(false);

  const projects =
    pendingEdits.size === 0
      ? portfolio.projects
      : portfolio.projects.map((view) => {
          const edit = pendingEdits.get(view.project.id);
          return edit ? { ...view, project: { ...view.project, ...edit } } : view;
        });
  const inRankOrder = (filter: "open" | "all") =>
    filterAndSortProjects(projects, {
      filter,
      sort: "rank",
      query: "",
      strategy: snapshot.strategy,
    });
  const isFinished = ({ project }: HubMergedProjectView) =>
    project.archived || project.status === "done";
  const finished = inRankOrder("all").filter(isFinished);
  // Rank is the open portfolio's, so a favourite shows the same number in both lists and
  // showing finished work never renumbers it.
  const rows = [
    ...inRankOrder("open").map((view, index) => ({ view, rank: (index + 1) as number | null })),
    ...(showFinished ? finished.map((view) => ({ view, rank: null })) : []),
  ].filter((row) => !favoritesOnly || row.view.project.favorite);

  const editProject = async (view: HubMergedProjectView, edit: HubProjectPatch) => {
    const environmentId = hubWriteEnvironment(view, portfolio.nodeNameByEnvironmentId, null);
    if (environmentId === null) {
      Dialog.alert(
        `Could not update ${view.project.name}`,
        "No connected machine has this project.",
      );
      return;
    }
    const { id } = view.project;
    setPendingEdits((current) => new Map(current).set(id, { ...current.get(id), ...edit }));
    const result = await upsertProject({ environmentId, input: { id, ...edit } });
    setPendingEdits((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      Dialog.alert(
        `Could not update ${view.project.name}`,
        failure instanceof Error ? failure.message : "The request failed.",
      );
    }
  };

  if (rows.length === 0) {
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
      <View collapsable={false} className="overflow-hidden rounded-[24px] bg-grouped-card">
        {rows.map(({ view, rank }, index) => {
          const target = t3ProjectForHubView(view, t3Projects, portfolio.nodeNameByEnvironmentId);
          const priority =
            view.project.priority === "none"
              ? null
              : labelOf(PRIORITY_OPTIONS, view.project.priority);
          const glance = projectGlance({
            project: view.project,
            nodes: view.nodes,
            selectedNodeName:
              (target && portfolio.nodeNameByEnvironmentId.get(target.environmentId)) ??
              snapshot.nodeName,
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
                accessibilityLabel={`${rank === null ? "Finished" : rank}, ${view.project.name}${target ? ", start a task" : ""}`}
                disabled={target === null}
                onPress={() => {
                  if (!target) return;
                  // A thread belongs to Chats; page tabs keep their tab bar over a pushed detail.
                  selectTab("threads");
                  selectDetail({
                    name: "Thread",
                    params: {
                      draft: {
                        environmentId: String(target.environmentId),
                        projectId: String(target.id),
                      },
                    },
                  });
                }}
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
      {!favoritesOnly && finished.length > 0 ? (
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

function ActivityView(props: { portfolio: Portfolio; bottomInset: number; header: ReactNode }) {
  const insights = useHubInsights();
  const [activityWindow, setActivityWindow] = useState<HubActivityWindow>("7d");
  const activity = buildHubActivity({
    projects: props.portfolio.projects,
    insights: insights.insights,
    strategy: props.portfolio.anySnapshot?.strategy ?? [],
    window: activityWindow,
  });
  const maxCommits = activity.rows[0]?.commits ?? 0;
  const windowLabel = labelOf(HUB_ACTIVITY_WINDOWS, activityWindow);
  const notes = [
    activity.quietCount > 0 ? `${activity.quietCount} quiet` : null,
    activity.unreportedCount > 0 ? `${activity.unreportedCount} not on a connected machine` : null,
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
      <SegmentedControl
        options={HUB_ACTIVITY_WINDOWS}
        selected={activityWindow}
        onSelect={setActivityWindow}
        size="compact"
      />
      {loading ? (
        <View className="items-center py-8" accessibilityLabel="Loading activity">
          <AppActivityIndicator colorClassName="accent-icon-muted" />
        </View>
      ) : (
        <>
          <View className="flex-row gap-3">
            <Stat label={`Commits · ${windowLabel}`} value={activity.totalCommits} />
            <Stat label="Active projects" value={activity.rows.length} />
            <Stat label="Agents running" value={activity.runningCount} />
          </View>
          {insights.error !== null ? (
            <Text className="text-xs leading-normal text-foreground-muted">
              Some activity is unavailable: {insights.error}
            </Text>
          ) : null}
          {activity.rows.length === 0 ? (
            <EmptyState
              variant="plain"
              title={`No commits in ${windowLabel}`}
              detail="Try a longer window."
            />
          ) : (
            <View
              collapsable={false}
              className="gap-4 rounded-[24px] bg-grouped-card px-4 py-4"
              accessibilityLabel={`Commits per project, ${windowLabel}`}
            >
              {activity.rows.map((row) => (
                <View
                  key={row.projectId}
                  className="gap-1.5"
                  accessible
                  accessibilityLabel={`${row.name}, ${row.commits} ${row.commits === 1 ? "commit" : "commits"}`}
                >
                  <View className="flex-row items-baseline gap-2">
                    <Text className="min-w-0 flex-1 text-sm font-t3-bold" numberOfLines={1}>
                      {row.name}
                    </Text>
                    {row.lastCommitAt ? (
                      <Text className="text-xs text-foreground-muted">
                        {relativeTime(row.lastCommitAt)} ago
                      </Text>
                    ) : null}
                    <Text className="text-sm font-t3-bold">{row.commits}</Text>
                  </View>
                  <View
                    className="h-1 rounded-full bg-primary"
                    style={{ width: `${Math.max(2, (row.commits / maxCommits) * 100)}%` }}
                  />
                </View>
              ))}
            </View>
          )}
          {notes.length > 0 ? (
            <Text className="text-center text-xs text-foreground-muted">{notes.join(" · ")}</Text>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

function Stat(props: { label: string; value: number }) {
  return (
    <View
      className="min-w-0 flex-1 gap-1 rounded-[20px] bg-grouped-card p-3"
      accessible
      accessibilityLabel={`${props.label}: ${props.value}`}
    >
      <Text className="text-2xl font-t3-bold">{props.value.toLocaleString()}</Text>
      <Text className="text-xs leading-snug text-foreground-muted">{props.label}</Text>
    </View>
  );
}

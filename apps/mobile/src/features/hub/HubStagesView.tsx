import { filterAndSortProjects } from "@t3tools/client-runtime/codrHub/hubFormat";
import { hubWriteEnvironment } from "@t3tools/client-runtime/codrHub/projectPickerModel";
import {
  groupByStageColumn,
  stageCardGlance,
  stageCardTasks,
  stageColumns,
  taskToggleCommand,
} from "@t3tools/client-runtime/codrHub/stageBoardModel";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, HubMergedProjectView, HubTask } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { hubProjectMenuActions, hubProjectPatchForAction } from "./hubProjectMenu";
import { useHubProjectEdits } from "./useHubProjectEdits";
import type { useHubPortfolio } from "./useHubPortfolio";
import { hubThreadActionLabel, useStartHubThread } from "./useStartHubThread";

type Portfolio = ReturnType<typeof useHubPortfolio>;

/** Open projects grouped by SDLC stage, in rank order; a row opens its board tasks as a checklist. */
export function HubStagesView(props: {
  portfolio: Portfolio;
  bottomInset: number;
  header: ReactNode;
}) {
  const snapshot = props.portfolio.anySnapshot!;
  const { projects, editProject } = useHubProjectEdits(props.portfolio);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const mode = snapshot.settings.sdlcMode;
  const columns = stageColumns(mode);
  const grouped = groupByStageColumn(
    filterAndSortProjects(projects, {
      filter: "open",
      sort: "rank",
      query: "",
      strategy: snapshot.strategy,
    }),
    columns,
  );
  const toggle = (projectId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(projectId)) next.add(projectId);
      return next;
    });

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      className="flex-1"
      contentContainerClassName="gap-5 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(props.bottomInset, 18) + 18 }}
      keyboardShouldPersistTaps="handled"
    >
      {props.header}
      {columns.map((column) => {
        const rows = grouped.get(column.id) ?? [];
        return (
          <View key={column.id} className="gap-2">
            <Text
              accessibilityRole="header"
              className="px-1 text-2xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted"
            >
              {column.label} · {rows.length}
            </Text>
            {rows.length === 0 ? (
              <Text className="px-1 text-sm text-foreground-muted">No projects</Text>
            ) : (
              <View collapsable={false} className="overflow-hidden rounded-[24px] bg-grouped-card">
                {rows.map((view, index) => (
                  <StageRow
                    key={view.project.id}
                    view={view}
                    portfolio={props.portfolio}
                    first={index === 0}
                    expanded={expanded.has(view.project.id)}
                    onToggle={() => toggle(view.project.id)}
                    onEdit={editProject}
                  />
                ))}
              </View>
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}

function StageRow(props: {
  view: HubMergedProjectView;
  portfolio: Portfolio;
  first: boolean;
  expanded: boolean;
  onToggle: () => void;
  onEdit: ReturnType<typeof useHubProjectEdits>["editProject"];
}) {
  const { view, portfolio } = props;
  const snapshot = portfolio.anySnapshot!;
  const mode = snapshot.settings.sdlcMode;
  const counts = snapshot.taskCounts?.[view.project.id];
  const countLabel = counts ? `${counts.done}/${counts.total}` : null;
  const glance = stageCardGlance(view, snapshot.strategy);

  return (
    <View className={cn("bg-grouped-card", !props.first && "border-t border-border-subtle")}>
      <View className="flex-row items-center">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${view.project.name}${countLabel ? `, ${countLabel} tasks done` : ""}`}
          accessibilityState={{ expanded: props.expanded }}
          onPress={props.onToggle}
          className="min-w-0 flex-1 flex-row items-center gap-2 py-3 ps-4"
        >
          <View className="min-w-0 flex-1">
            <Text className="text-base font-t3-bold leading-snug" numberOfLines={1}>
              {view.project.name}
            </Text>
            {glance ? (
              <Text className="text-xs leading-snug text-foreground-muted" numberOfLines={1}>
                {glance}
              </Text>
            ) : null}
          </View>
          {countLabel ? (
            <Text className="text-sm font-t3-bold text-foreground-muted">{countLabel}</Text>
          ) : null}
          <SymbolView
            name={props.expanded ? "chevron.down" : "chevron.right"}
            size={12}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
          />
        </Pressable>
        <Menu
          title={view.project.name}
          actions={hubProjectMenuActions(view.project, snapshot.strategy, mode)}
          onPressAction={({ nativeEvent }) => {
            const edit = hubProjectPatchForAction(nativeEvent.event, mode);
            if (edit) void props.onEdit(view, edit);
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
      </View>
      {props.expanded ? <ProjectTasks view={view} portfolio={portfolio} /> : null}
    </View>
  );
}

function reportFailure(
  title: string,
  result: Extract<AtomCommandResult<unknown, unknown>, { _tag: "Failure" }>,
) {
  if (isAtomCommandInterrupted(result)) return;
  const failure = squashAtomCommandFailure(result);
  Dialog.alert(title, failure instanceof Error ? failure.message : "The request failed.");
}

function ProjectTasks(props: { view: HubMergedProjectView; portfolio: Portfolio }) {
  const environmentId = hubWriteEnvironment(
    props.view,
    props.portfolio.nodeNameByEnvironmentId,
    null,
  );
  const startThread = useStartHubThread(props.portfolio.nodeNameByEnvironmentId);
  const threadTarget = startThread.targetFor(props.view);
  return (
    <View className="gap-1 border-t border-border-subtle px-4 pb-3 pt-2">
      {environmentId === null ? (
        <Text className="py-2 text-sm text-foreground-muted">
          No connected machine has this project.
        </Text>
      ) : (
        <TaskChecklist environmentId={environmentId} projectId={props.view.project.id} />
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`New thread, ${hubThreadActionLabel(threadTarget)}`}
        onPress={() => startThread.start(props.view, threadTarget)}
        className="min-h-11 flex-row items-center gap-2"
      >
        <SymbolView
          name="plus.bubble"
          size={18}
          tintColorClassName="accent-foreground"
          type="monochrome"
        />
        <Text className="text-sm font-t3-bold">New thread</Text>
      </Pressable>
    </View>
  );
}

/** Subscribes to one project's board only while its row is open. */
function TaskChecklist(props: { environmentId: EnvironmentId; projectId: string }) {
  const board = useEnvironmentQuery(
    serverEnvironment.hubBoardLive({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const apply = useAtomCommand(serverEnvironment.hubBoardApply, { reportFailure: false });
  // Ticks show at once; the board snapshot replaces them once the commit lands.
  const [pendingDone, setPendingDone] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  if (board.data === null) {
    return board.failure !== null ? (
      <Text className="py-2 text-sm text-foreground-muted">Could not load tasks.</Text>
    ) : (
      <View className="items-start py-2">
        <AppActivityIndicator colorClassName="accent-icon-muted" />
      </View>
    );
  }
  const allTasks = board.data.tasks;
  const tasks = stageCardTasks(allTasks);

  const setDone = async (task: HubTask, done: boolean) => {
    setPendingDone((current) => new Map(current).set(task.id, done));
    const result = await apply({
      environmentId: props.environmentId,
      input: taskToggleCommand(allTasks, task, done),
    });
    setPendingDone((current) => {
      const next = new Map(current);
      next.delete(task.id);
      return next;
    });
    if (result._tag === "Failure") reportFailure("Could not update the task", result);
  };

  const add = async () => {
    const title = draft.trim();
    if (title === "" || adding) return;
    setAdding(true);
    const result = await apply({
      environmentId: props.environmentId,
      input: {
        type: "create",
        projectId: props.projectId,
        id: uuidv4(),
        title,
        column: "todo",
      },
    });
    setAdding(false);
    if (result._tag === "Failure") reportFailure("Could not add the task", result);
    else setDraft("");
  };

  return (
    <View className="gap-1">
      {tasks.map((task) => {
        const done = pendingDone.get(task.id) ?? task.column === "done";
        return (
          <Pressable
            key={task.id}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: done }}
            accessibilityLabel={task.title}
            onPress={() => void setDone(task, !done)}
            className="min-h-11 flex-row items-center gap-3"
          >
            <SymbolView
              name={done ? "checkmark.circle.fill" : "circle"}
              size={20}
              tintColorClassName={done ? "accent-foreground" : "accent-icon-subtle"}
              type="monochrome"
            />
            <Text
              className={cn(
                "min-w-0 flex-1 text-sm leading-snug",
                done && "text-foreground-muted line-through",
              )}
            >
              {task.title}
              {task.column === "in_progress" || task.column === "ready_for_testing" ? (
                <Text className="text-xs text-foreground-muted">
                  {task.column === "in_progress" ? "  In progress" : "  Ready for testing"}
                </Text>
              ) : null}
            </Text>
          </Pressable>
        );
      })}
      <AppTextInput
        value={draft}
        onChangeText={setDraft}
        placeholder="Add a task"
        accessibilityLabel="New task"
        returnKeyType="done"
        submitBehavior="submit"
        editable={!adding}
        onSubmitEditing={() => void add()}
        className="mt-1 min-h-11 py-2 text-sm"
      />
    </View>
  );
}

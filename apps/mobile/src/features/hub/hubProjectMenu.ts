import {
  PRIORITY_OPTIONS,
  STATUS_OPTIONS,
  labelOf,
  stageOptions,
  stageSelectValue,
} from "@t3tools/client-runtime/codrHub/hubFormat";
import type {
  HubProject,
  HubSdlcMode,
  HubStrategyPriority,
  HubUpsertProjectInput,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";

export type HubProjectPatch = Pick<
  HubUpsertProjectInput,
  "priority" | "status" | "stage" | "strategyId" | "archived" | "favorite"
>;

const NO_STRATEGY = "none";

function group<V extends string>(
  key: string,
  title: string,
  options: ReadonlyArray<{ value: V; label: string }>,
  selected: V,
): MenuAction {
  return {
    id: key,
    title,
    subtitle: labelOf(options, selected),
    subactions: options.map((option) => ({
      id: `${key}:${option.value}`,
      title: option.label,
      state: option.value === selected ? "on" : "off",
    })),
  };
}

const strategyOptions = (strategy: ReadonlyArray<HubStrategyPriority>) => [
  { value: NO_STRATEGY, label: "None" },
  ...strategy.map((priority) => ({ value: priority.id, label: priority.title })),
];

export function hubProjectMenuActions(
  project: HubProject,
  strategy: ReadonlyArray<HubStrategyPriority>,
  mode: HubSdlcMode,
): MenuAction[] {
  return [
    group("priority", "Priority", PRIORITY_OPTIONS, project.priority),
    group("status", "Status", STATUS_OPTIONS, project.status),
    group("stage", "Stage", stageOptions(mode), stageSelectValue(project.stage, mode)),
    ...(strategy.length > 0
      ? [
          group(
            "strategy",
            "Strategy",
            strategyOptions(strategy),
            project.strategyId !== null && strategy.some(({ id }) => id === project.strategyId)
              ? project.strategyId
              : NO_STRATEGY,
          ),
        ]
      : []),
    project.archived
      ? { id: "unarchive", title: "Unarchive" }
      : { id: "archive", title: "Archive", attributes: { destructive: true } },
  ];
}

/** The write a chosen menu action asks for. Null for an id this menu never produced. */
export function hubProjectPatchForAction(
  actionId: string,
  mode: HubSdlcMode,
): HubProjectPatch | null {
  if (actionId === "archive") return { archived: true };
  if (actionId === "unarchive") return { archived: false };
  const separator = actionId.indexOf(":");
  if (separator < 0) return null;
  const key = actionId.slice(0, separator);
  const value = actionId.slice(separator + 1);
  switch (key) {
    case "priority": {
      const priority = PRIORITY_OPTIONS.find((option) => option.value === value)?.value;
      return priority ? { priority } : null;
    }
    case "status": {
      const status = STATUS_OPTIONS.find((option) => option.value === value)?.value;
      return status ? { status } : null;
    }
    case "stage": {
      const stage = stageOptions(mode).find((option) => option.value === value)?.value;
      return stage ? { stage } : null;
    }
    case "strategy":
      return { strategyId: value === NO_STRATEGY ? null : value };
    default:
      return null;
  }
}

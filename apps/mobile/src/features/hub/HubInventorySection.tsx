import {
  attentionList,
  attentionStat,
  buildInventory,
  INVENTORY_CATEGORIES,
  type InventoryMachine,
} from "@t3tools/client-runtime/codrHub/inventoryModel";
import { machineColor } from "@t3tools/client-runtime/codrHub/projectPickerModel";
import {
  ATTENTION_REASONS,
  type AttentionReason,
} from "@t3tools/client-runtime/codrHub/scanAttention";
import type { ProjectIconColor } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { ScrollView as HorizontalScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Chip } from "../../components/ui/Chip";
import { cn } from "../../lib/cn";
import { projectIconColorClassNames } from "../../lib/projectIcon";
import type { useHubPortfolio } from "./useHubPortfolio";

type Portfolio = ReturnType<typeof useHubPortfolio>;

/** Literal classes, so the stylesheet build sees every machine fill. */
const MACHINE_FILL: Record<ProjectIconColor, string> = {
  gray: "bg-gray-500",
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  yellow: "bg-yellow-500",
  lime: "bg-lime-500",
  green: "bg-green-500",
  emerald: "bg-emerald-500",
  teal: "bg-teal-500",
  cyan: "bg-cyan-500",
  sky: "bg-sky-500",
  blue: "bg-blue-500",
  indigo: "bg-indigo-500",
  violet: "bg-violet-500",
  purple: "bg-purple-500",
  fuchsia: "bg-fuchsia-500",
  pink: "bg-pink-500",
  rose: "bg-rose-500",
};

const count = (value: number) => value.toLocaleString();
const plural = (value: number, one: string, many: string) =>
  `${count(value)} ${value === 1 ? one : many}`;
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).slice(-2).join("/");

/** What the disk scans say: totals, a card per machine, and what needs a look. */
export function HubInventorySection(props: { portfolio: Portfolio; today: string }) {
  const { portfolio } = props;
  const nodeColors = portfolio.anySnapshot?.settings.nodeColors;
  const inventory = useMemo(
    () =>
      buildInventory({
        projects: portfolio.projects.map((view) => view.project),
        extraNodes: [...new Set(portfolio.nodeNameByEnvironmentId.values())],
        today: props.today,
      }),
    [portfolio.projects, portfolio.nodeNameByEnvironmentId, props.today],
  );
  const [picked, setPicked] = useState<AttentionReason | null>(null);
  if (inventory.machines.length === 0) return null;
  const colorOf = (node: string) => machineColor(node, nodeColors ?? {});
  const { totals } = inventory;
  const reason =
    picked ??
    ATTENTION_REASONS.find((entry) => inventory.reasonCounts[entry.value] > 0)?.value ??
    "at-risk";
  const why = ATTENTION_REASONS.find((entry) => entry.value === reason)!.why;
  const rows = attentionList(inventory.rows, reason);

  return (
    <View className="gap-3">
      <Text
        accessibilityRole="header"
        className="px-1 text-2xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted"
      >
        Inventory · from disk scans
      </Text>
      <View className="flex-row gap-3">
        <Stat
          label="Projects scanned"
          value={count(totals.projects)}
          detail={plural(totals.checkouts, "checkout", "checkouts")}
        />
        <Stat
          label="Have a remote"
          value={`${Math.round(totals.remoteShare * 100)}%`}
          detail="of checkouts"
        />
        <Stat
          label="Need attention"
          value={count(totals.attentionProjects)}
          detail="projects"
          alert={totals.attentionProjects > 0}
        />
      </View>
      <View className="flex-row gap-3">
        <Stat label="Uncommitted work" value={count(totals.dirtyCheckouts)} detail="checkouts" />
        <Stat label="Unpushed commits" value={count(totals.unpushedCheckouts)} detail="checkouts" />
        <Stat label="Not scanned" value={count(totals.notScanned)} detail="projects" />
      </View>
      {inventory.machines.map((machine) => (
        <MachineCard key={machine.node} machine={machine} color={colorOf(machine.node)} />
      ))}
      {totals.checkouts > 0 ? (
        <View className="gap-2">
          <HorizontalScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            className="-mx-5"
            contentContainerClassName="gap-2 px-5"
          >
            {ATTENTION_REASONS.map((entry) => (
              <Chip
                key={entry.value}
                label={`${entry.label} ${inventory.reasonCounts[entry.value]}`}
                selected={entry.value === reason}
                onPress={() => setPicked(entry.value)}
              />
            ))}
          </HorizontalScrollView>
          <View collapsable={false} className="overflow-hidden rounded-[24px] bg-grouped-card">
            {rows.length === 0 ? (
              <Text className="px-4 py-3 text-sm text-foreground-muted">Nothing here.</Text>
            ) : (
              rows.map((row, index) => (
                <View
                  key={row.key}
                  accessible
                  accessibilityLabel={`${row.projectName}, ${row.node}, ${why}, ${attentionStat(row)}`}
                  className={cn(
                    "flex-row items-center gap-3 px-4 py-3",
                    index > 0 && "border-t border-border-subtle",
                  )}
                >
                  <View className={cn("size-2 rounded-full", MACHINE_FILL[colorOf(row.node)])} />
                  <View className="min-w-0 flex-1">
                    <Text
                      className={cn(
                        "text-sm font-t3-bold leading-snug",
                        reason === "at-risk" && "text-danger-foreground",
                      )}
                      numberOfLines={1}
                    >
                      {row.projectName}
                    </Text>
                    <Text className="text-xs leading-snug text-foreground-muted" numberOfLines={1}>
                      {[row.node, row.scan?.engine, row.primary ? null : folderName(row.path), why]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  </View>
                  <Text className="text-xs text-foreground-muted">{attentionStat(row)}</Text>
                </View>
              ))
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Stat(props: { label: string; value: string; detail: string; alert?: boolean }) {
  return (
    <View
      className="min-w-0 flex-1 gap-1 rounded-[20px] bg-grouped-card p-3"
      accessible
      accessibilityLabel={`${props.label}: ${props.value} ${props.detail}`}
    >
      <Text
        className={cn("text-xl font-t3-bold", props.alert && "text-danger-foreground")}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {props.value}
      </Text>
      <Text className="text-xs leading-snug text-foreground-muted" numberOfLines={2}>
        {props.label}
      </Text>
      <Text className="text-2xs leading-snug text-foreground-muted" numberOfLines={1}>
        {props.detail}
      </Text>
    </View>
  );
}

function MachineCard(props: { machine: InventoryMachine; color: ProjectIconColor }) {
  const { machine } = props;
  const fill = MACHINE_FILL[props.color];
  const total = Math.max(1, machine.checkouts);
  return (
    <View
      className="gap-3 overflow-hidden rounded-[24px] bg-grouped-card p-4"
      accessible
      accessibilityLabel={
        machine.checkouts === 0
          ? `${machine.node}, no scan yet`
          : `${machine.node}, ${plural(machine.checkouts, "checkout", "checkouts")}: ${machine.remote} with a remote, ${machine.local} local git, ${machine.none} no git`
      }
    >
      <View className="flex-row items-center gap-2">
        <View className={cn("size-2.5 rounded-full", fill)} />
        <Text className="min-w-0 flex-1 text-base font-t3-bold" numberOfLines={1}>
          {machine.node}
        </Text>
        {machine.checkouts > 0 ? (
          <Text
            className={cn("text-2xl font-t3-bold", projectIconColorClassNames(props.color).text)}
          >
            {count(machine.checkouts)}
          </Text>
        ) : null}
      </View>
      {machine.checkouts === 0 ? (
        <Text className="text-sm text-foreground-muted">
          No scan yet. Use Scan all machines under Ranked while this machine is connected.
        </Text>
      ) : (
        <>
          <View className="h-2 flex-row gap-0.5 overflow-hidden rounded-full bg-subtle-strong">
            <View className={fill} style={{ flex: machine.remote / total }} />
            <View className={cn(fill, "opacity-40")} style={{ flex: machine.local / total }} />
            <View style={{ flex: machine.none / total }} />
          </View>
          <Text className="text-xs text-foreground-muted">
            {count(machine.remote)} remote · {count(machine.local)} local git ·{" "}
            {count(machine.none)} no git
          </Text>
          <View className="flex-row border-t border-border-subtle pt-3">
            {INVENTORY_CATEGORIES.map((category) => (
              <View key={category} className="flex-1">
                <Text className="text-sm font-t3-bold">
                  {count(machine.categories[category] ?? 0)}
                </Text>
                <Text className="text-2xs text-foreground-muted">{category}</Text>
              </View>
            ))}
          </View>
        </>
      )}
    </View>
  );
}

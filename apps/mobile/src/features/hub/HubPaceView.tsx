import { paceSummary, formatTimeUntilLabel } from "@t3tools/client-runtime/codrHub/hubFormat";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, HubPace } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { View } from "react-native";

import { ProviderIcon } from "../../components/ProviderIcon";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { useNowMinuteMs } from "../../lib/clock";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

function reportFailure(
  title: string,
  result: Extract<AtomCommandResult<unknown, unknown>, { _tag: "Failure" }>,
) {
  if (isAtomCommandInterrupted(result)) return;
  const failure = squashAtomCommandFailure(result);
  Dialog.alert(title, failure instanceof Error ? failure.message : "The request failed.");
}

/** Pace and the autopilot belong to one machine, so each connected machine gets its own card. */
export function HubMachinePace(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const { environmentId, label } = props;
  const hub = useEnvironmentQuery(serverEnvironment.hubLive({ environmentId, input: {} }));
  const setNode = useAtomCommand(serverEnvironment.hubSetNode, { reportFailure: false });
  const runAutopilot = useAtomCommand(serverEnvironment.hubRunAutopilot, { reportFailure: false });
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const snapshot = hub.data;

  if (snapshot === null) {
    return (
      <Card>
        <Text className="text-base font-t3-bold">{label}</Text>
        {hub.error !== null ? (
          <Text className="text-sm leading-normal text-foreground-muted">
            Hub isn't available here. This machine needs to run Codr-Hub.
          </Text>
        ) : (
          <AppActivityIndicator colorClassName="accent-icon-muted" />
        )}
      </Card>
    );
  }

  const enabled = pendingEnabled ?? snapshot.autopilotEnabled;
  const writeEnabled = async (next: boolean) => {
    setPendingEnabled(next);
    const result = await setNode({ environmentId, input: { autopilotEnabled: next } });
    setPendingEnabled(null);
    if (result._tag === "Failure") reportFailure("Could not change the autopilot", result);
  };
  const toggle = (next: boolean) => {
    if (!next) {
      void writeEnabled(false);
      return;
    }
    Dialog.confirm({
      title: `Turn on the autopilot on ${snapshot.nodeName}?`,
      message: "It starts agents on your projects and spends subscription quota until you stop it.",
      confirmText: "Turn on",
      onConfirm: () => void writeEnabled(true),
    });
  };
  const runOnce = async () => {
    setRunning(true);
    setOutcome(null);
    const result = await runAutopilot({ environmentId, input: {} });
    setRunning(false);
    if (result._tag === "Failure") reportFailure("Autopilot run failed", result);
    else {
      // The reason nothing started arrives as the snapshot's autopilot note.
      const { length } = result.value.launched;
      setOutcome(
        length > 0
          ? `Started ${length} ${length === 1 ? "thread" : "threads"}.`
          : "Nothing started.",
      );
    }
  };

  return (
    <Card>
      <View className="flex-row items-center gap-3">
        <View className="min-w-0 flex-1">
          <Text className="text-base font-t3-bold" numberOfLines={1}>
            {snapshot.nodeName}
          </Text>
          <Text className="text-xs text-foreground-muted">Autopilot {enabled ? "on" : "off"}</Text>
        </View>
        <ThemedSwitch
          accessibilityLabel={`Autopilot on ${snapshot.nodeName}`}
          value={enabled}
          disabled={pendingEnabled !== null}
          onValueChange={toggle}
        />
      </View>
      {snapshot.autopilotNote ? (
        <Text className="text-xs leading-normal text-foreground-muted">
          {snapshot.autopilotNote}
        </Text>
      ) : null}
      {snapshot.pace.length === 0 ? (
        <Text className="text-sm leading-normal text-foreground-muted">
          No providers are enabled on this machine.
        </Text>
      ) : (
        <>
          {snapshot.pace.map((pace) => (
            <PaceRow key={pace.instanceId} environmentId={environmentId} pace={pace} />
          ))}
          <View className="items-start gap-2">
            <Button
              tone="secondary"
              label={running ? "Launching…" : "Run once"}
              disabled={running}
              onPress={() =>
                Dialog.confirm({
                  title: `Run the autopilot once on ${snapshot.nodeName}?`,
                  message: "It can start an agent on your top eligible project.",
                  confirmText: "Run once",
                  onConfirm: () => void runOnce(),
                })
              }
            />
            {outcome ? (
              <Text className="text-xs leading-normal text-foreground-muted">{outcome}</Text>
            ) : null}
          </View>
        </>
      )}
    </Card>
  );
}

function Card(props: { readonly children: ReactNode }) {
  return <View className="gap-4 rounded-[24px] bg-grouped-card p-4">{props.children}</View>;
}

function PaceRow(props: { readonly environmentId: EnvironmentId; readonly pace: HubPace }) {
  const { pace } = props;
  const nowMs = useNowMinuteMs();
  return (
    <View className="gap-1.5" accessible={false}>
      <View className="flex-row items-center gap-2">
        <ProviderIcon provider={pace.driver} size={16} />
        <Text className="min-w-0 flex-1 text-sm font-t3-bold" numberOfLines={1}>
          {pace.label}
        </Text>
        {pace.running > 0 ? (
          <Text className="text-xs text-foreground-muted">{pace.running} running</Text>
        ) : null}
      </View>
      <Text className="text-xs leading-normal text-foreground-muted">
        {paceSummary(pace, nowMs)}
      </Text>
      {pace.usedPercent !== null ? (
        <PaceBar used={pace.usedPercent} target={pace.targetPercent} />
      ) : null}
      {pace.state !== "on_pace" ? (
        <Text className="text-xs leading-normal text-foreground-muted">{pace.reason}</Text>
      ) : null}
      {pace.bankedResets > 0 ? (
        <BankedResets environmentId={props.environmentId} pace={pace} nowMs={nowMs} />
      ) : null}
    </View>
  );
}

/** Used so far, with a tick where this point in the window should be. */
function PaceBar(props: { readonly used: number; readonly target: number | null }) {
  const clamp = (percent: number) => Math.min(100, Math.max(0, percent));
  return (
    <View
      className="mt-1 h-1 rounded-full bg-subtle-strong"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View className="h-1 rounded-full bg-primary" style={{ width: `${clamp(props.used)}%` }} />
      {props.target !== null ? (
        <View
          className="absolute -top-1 h-3 w-0.5 rounded-full bg-foreground"
          style={{ left: `${clamp(props.target)}%` }}
        />
      ) : null}
    </View>
  );
}

function BankedResets(props: {
  readonly environmentId: EnvironmentId;
  readonly pace: HubPace;
  readonly nowMs: number;
}) {
  const { environmentId, pace } = props;
  const consume = useAtomCommand(serverEnvironment.consumeResetCredit, { reportFailure: false });
  const [deploying, setDeploying] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const deploy = async () => {
    setDeploying(true);
    const result = await consume({ environmentId, input: { instanceId: pace.instanceId } });
    setDeploying(false);
    if (result._tag === "Failure") reportFailure("Could not deploy the banked reset", result);
    else setOutcome(result.value.warning ?? "Reset deployed.");
  };
  return (
    <View className="mt-1 gap-2">
      <View className="flex-row items-center gap-3">
        <Text className="min-w-0 flex-1 text-xs leading-normal text-foreground-muted">
          {pace.bankedResets} banked reset{pace.bankedResets === 1 ? "" : "s"}
          {pace.bankedResetExpiresAt
            ? ` · expires ${formatTimeUntilLabel(pace.bankedResetExpiresAt, props.nowMs)}`
            : ""}
        </Text>
        <Button
          tone="secondary"
          label={deploying ? "Deploying…" : "Deploy reset"}
          disabled={deploying}
          onPress={() =>
            Dialog.confirm({
              title: `Deploy a banked reset on ${pace.label}?`,
              message: "This uses it right away and can't be undone.",
              confirmText: "Deploy",
              destructive: true,
              onConfirm: () => void deploy(),
            })
          }
        />
      </View>
      {outcome ? (
        <Text className="text-xs leading-normal text-foreground-muted">{outcome}</Text>
      ) : null}
    </View>
  );
}

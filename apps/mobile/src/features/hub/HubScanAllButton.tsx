import { runScanAll, scanAllPlan } from "@t3tools/client-runtime/codrHub/scanAllMachines";
import { useState } from "react";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useConnectedHubMachines, type useHubPortfolio } from "./useHubPortfolio";

/** Scans every connected machine's disks and imports the results, after a confirm. */
export function HubScanAllButton(props: { portfolio: ReturnType<typeof useHubPortfolio> }) {
  const machines = useConnectedHubMachines();
  const importScan = useAtomCommand(serverEnvironment.hubImport, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const plan = scanAllPlan({
    hubEnvironmentIds: props.portfolio.hubEnvironmentIds,
    connectedEnvironmentIds: machines.map((machine) => machine.environmentId),
    nodeNameByEnvironmentId: props.portfolio.nodeNameByEnvironmentId,
    projects: props.portfolio.projects,
  });
  if (plan.targets.length === 0) return null;

  const scan = async () => {
    setBusy(true);
    const lines = await runScanAll(plan, ({ environmentId }) =>
      importScan({ environmentId, input: { source: "scan", scanThisMachine: true } }),
    );
    setBusy(false);
    Dialog.alert(
      "Scan all machines",
      lines.map((line) => `${line.nodeName}: ${line.text}`).join("\n\n"),
    );
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy, disabled: busy }}
      disabled={busy}
      onPress={() =>
        Dialog.confirm({
          title: "Scan all machines?",
          message: `Scans the disks of ${plan.targets.map((target) => target.nodeName).join(", ")} and imports what it finds. This can take several minutes. Each machine needs an up-to-date Codr-Hub.`,
          confirmText: "Scan",
          onConfirm: () => void scan(),
        })
      }
      className="min-h-11 items-center justify-center"
    >
      <Text className="text-sm text-foreground-muted">
        {busy ? "Scanning all machines…" : "Scan all machines"}
      </Text>
    </Pressable>
  );
}

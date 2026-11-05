import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { hubMergedProjectsKey } from "@t3tools/client-runtime/state/server";

import { serverEnvironment } from "../../state/server";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";

/** Connected environments, which may include T3 Code servers without the Hub. */
export function useConnectedHubMachines() {
  const { connectedEnvironments } = useRemoteConnectionStatus();
  return connectedEnvironments
    .filter((environment) => environment.connectionState === "connected")
    .map(({ environmentId, environmentLabel }) => ({ environmentId, label: environmentLabel }));
}

function useConnectedKey() {
  const ids = useConnectedHubMachines().map((machine) => machine.environmentId);
  return { count: ids.length, key: JSON.stringify(ids) };
}

/** The Hub portfolio, merged across every connected environment. */
export function useHubPortfolio() {
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const connectedCount = useConnectedHubMachines().length;
  const key = hubMergedProjectsKey(
    connectedEnvironments.map(({ environmentId, connectionState }) => ({
      environmentId,
      phase: connectionState,
    })),
  );
  const merged = useAtomValue(
    key === null
      ? serverEnvironment.hubMergedProjectsEmpty
      : serverEnvironment.hubMergedProjects(key),
  );
  return { ...merged, connectedCount };
}

/** Commit activity. Only the Activity view reads it, since a cold scan takes seconds. */
export function useHubInsights() {
  const { count, key } = useConnectedKey();
  const atom =
    count === 0
      ? serverEnvironment.hubMergedInsightsEmpty
      : serverEnvironment.hubMergedInsights(key);
  return { ...useAtomValue(atom), refresh: useAtomRefresh(atom) };
}

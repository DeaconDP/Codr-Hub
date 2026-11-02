import { useAtomRefresh, useAtomValue } from "@effect/atom-react";

import { serverEnvironment } from "../../state/server";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";

function useConnectedKey() {
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const ids = connectedEnvironments
    .filter((environment) => environment.connectionState === "connected")
    .map((environment) => environment.environmentId);
  return { count: ids.length, key: JSON.stringify(ids) };
}

/** The Hub portfolio, merged across every connected environment. */
export function useHubPortfolio() {
  const { count, key } = useConnectedKey();
  const merged = useAtomValue(
    count === 0
      ? serverEnvironment.hubMergedProjectsEmpty
      : serverEnvironment.hubMergedProjects(key),
  );
  return { ...merged, connectedCount: count };
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

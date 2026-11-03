import type { HubProjectSort } from "@t3tools/client-runtime/codrHub/hubFormat";
import {
  linkPickerRows,
  sortPickerRows,
  type PickerRow,
} from "@t3tools/client-runtime/codrHub/projectPickerModel";

import type { HomeProjectScope } from "../home/homeThreadList";
import { useHubPortfolio } from "./useHubPortfolio";

const latestActivity = (group: { scope: HomeProjectScope }) =>
  group.scope.projects.reduce<string | null>(
    (latest, project) =>
      latest === null || (project.updatedAt ?? "") > latest
        ? (project.updatedAt ?? latest)
        : latest,
    null,
  );

/**
 * Orders picker scopes by `sort`, favourites first by default, matching the web picker. Without
 * the Hub only name and recent apply, and no row has a portfolio project to star.
 */
export function useHubOrderedScopes(
  scopes: ReadonlyArray<HomeProjectScope>,
  sort: HubProjectSort = "favorites",
) {
  const { projects, nodeNameByEnvironmentId, anySnapshot } = useHubPortfolio();
  const hubAvailable = nodeNameByEnvironmentId.size > 0;
  const rows = linkPickerRows(
    scopes.map((scope) => ({
      scope,
      projectKey: scope.key,
      displayName: scope.title,
      memberProjects: scope.projects,
    })),
    hubAvailable ? projects : [],
    nodeNameByEnvironmentId,
  );
  const sorted = sortPickerRows(rows, hubAvailable || sort === "recent" ? sort : "name", {
    strategy: anySnapshot?.strategy ?? [],
    activeAt: latestActivity,
  });
  return {
    hubAvailable,
    nodeNameByEnvironmentId,
    scopes: sorted.map((row) => row.group.scope),
    rowByKey: new Map<string, PickerRow>(sorted.map((row) => [row.group.projectKey, row])),
    favoriteKeys: new Set(
      sorted.filter((row) => row.hub?.project.favorite === true).map((row) => row.group.projectKey),
    ),
  };
}

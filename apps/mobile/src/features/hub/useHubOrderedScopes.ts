import { linkPickerRows, pickerSections } from "@t3tools/client-runtime/codrHub/projectPickerModel";

import type { HomeProjectScope } from "../home/homeThreadList";
import { useHubPortfolio } from "./useHubPortfolio";

/**
 * Favourites first, then the Hub's manual order, matching the web picker. Keeps the given order
 * on an environment without the Hub.
 */
export function useHubOrderedScopes(scopes: ReadonlyArray<HomeProjectScope>) {
  const { projects, nodeNameByEnvironmentId } = useHubPortfolio();
  if (nodeNameByEnvironmentId.size === 0) {
    return { scopes, favoriteKeys: new Set<string>() };
  }
  const rows = linkPickerRows(
    scopes.map((scope) => ({
      scope,
      projectKey: scope.key,
      displayName: scope.title,
      memberProjects: scope.projects,
    })),
    projects,
    nodeNameByEnvironmentId,
  );
  const { favorites, others } = pickerSections(rows);
  return {
    scopes: [...favorites, ...others].map((row) => row.group.scope),
    favoriteKeys: new Set(favorites.map((row) => row.group.projectKey)),
  };
}

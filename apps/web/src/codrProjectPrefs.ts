import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const PROJECT_PRIORITIES = ["high", "normal", "low"] as const;
export type ProjectPriority = (typeof PROJECT_PRIORITIES)[number];

export const PROJECT_PRIORITY_LABELS: Record<ProjectPriority, string> = {
  high: "High",
  normal: "Normal",
  low: "Low",
};

interface CodrProjectPrefsState {
  favorites: string[];
  priorities: Record<string, Exclude<ProjectPriority, "normal">>;
  toggleFavorite: (projectKey: string) => void;
  setPriority: (projectKey: string, priority: ProjectPriority) => void;
}

// ponytail: per-client localStorage, like T3's manual project order. Move to server settings if prefs must follow the user across devices.
export const useCodrProjectPrefs = create<CodrProjectPrefsState>()(
  persist(
    (set) => ({
      favorites: [],
      priorities: {},
      toggleFavorite: (projectKey) =>
        set((state) => ({
          favorites: state.favorites.includes(projectKey)
            ? state.favorites.filter((key) => key !== projectKey)
            : [...state.favorites, projectKey],
        })),
      setPriority: (projectKey, priority) =>
        set((state) => {
          const { [projectKey]: _previous, ...priorities } = state.priorities;
          return {
            priorities:
              priority === "normal" ? priorities : { ...priorities, [projectKey]: priority },
          };
        }),
    }),
    {
      name: "codr:project-prefs:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ favorites, priorities }) => ({ favorites, priorities }),
    },
  ),
);

export function projectPriority(
  priorities: CodrProjectPrefsState["priorities"],
  projectKey: string,
): ProjectPriority {
  return priorities[projectKey] ?? "normal";
}

/** Favorites first, then by priority; T3's own sort order breaks ties (stable sort). */
export function rankProjects<T extends { projectKey: string }>(
  projects: readonly T[],
  favorites: readonly string[],
  priorities: CodrProjectPrefsState["priorities"],
): T[] {
  const favoriteSet = new Set(favorites);
  const rank = (project: T) =>
    (favoriteSet.has(project.projectKey) ? 0 : 3) +
    PROJECT_PRIORITIES.indexOf(projectPriority(priorities, project.projectKey));
  return projects.toSorted((left, right) => rank(left) - rank(right));
}

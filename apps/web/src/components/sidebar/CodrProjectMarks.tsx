import { FlagIcon, StarIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import {
  PROJECT_PRIORITY_LABELS,
  projectPriority,
  type ProjectPriority,
  useCodrProjectPrefs,
} from "../../codrProjectPrefs";
import { Button } from "../ui/button";

const NEXT_PRIORITY: Record<ProjectPriority, ProjectPriority> = {
  normal: "high",
  high: "low",
  low: "normal",
};

const PRIORITY_FLAG_CLASS_NAME: Record<ProjectPriority, string> = {
  high: "fill-current text-warning",
  normal: "",
  low: "text-muted-foreground",
};

// Unset marks stay out of the way until the row is hovered or highlighted.
const REVEAL_ON_ROW = "opacity-0 in-data-highlighted:opacity-100 pointer-coarse:opacity-100";

function useProjectMarks(projectKey: string) {
  const favorite = useCodrProjectPrefs((state) => state.favorites.includes(projectKey));
  const priority = useCodrProjectPrefs((state) => projectPriority(state.priorities, projectKey));
  return { favorite, priority };
}

/** Favorite and priority toggles for a project picker row. */
export function ProjectMarkButtons(props: { projectKey: string; projectName: string }) {
  const { favorite, priority } = useProjectMarks(props.projectKey);
  const toggleFavorite = useCodrProjectPrefs((state) => state.toggleFavorite);
  const setPriority = useCodrProjectPrefs((state) => state.setPriority);
  const nextPriority = NEXT_PRIORITY[priority];
  return (
    <>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        tabIndex={-1}
        aria-label={`${PROJECT_PRIORITY_LABELS[priority]} priority, set ${PROJECT_PRIORITY_LABELS[nextPriority].toLowerCase()} for ${props.projectName}`}
        title={`Priority: ${PROJECT_PRIORITY_LABELS[priority]} (click for ${PROJECT_PRIORITY_LABELS[nextPriority]})`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setPriority(props.projectKey, nextPriority);
        }}
      >
        <FlagIcon
          className={cn(
            "size-3.5",
            priority === "normal" ? REVEAL_ON_ROW : PRIORITY_FLAG_CLASS_NAME[priority],
          )}
        />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        tabIndex={-1}
        aria-pressed={favorite}
        aria-label={favorite ? `Unfavorite ${props.projectName}` : `Favorite ${props.projectName}`}
        title={favorite ? "Remove from favorites" : "Add to favorites"}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleFavorite(props.projectKey);
        }}
      >
        <StarIcon
          className={cn("size-3.5", favorite ? "fill-current text-warning" : REVEAL_ON_ROW)}
        />
      </Button>
    </>
  );
}

/** Read-only marks for rows that are themselves buttons. */
export function ProjectMarkIcons(props: { projectKey: string }) {
  const { favorite, priority } = useProjectMarks(props.projectKey);
  return (
    <>
      {priority !== "normal" ? (
        <FlagIcon
          aria-label={`${PROJECT_PRIORITY_LABELS[priority]} priority`}
          className={cn("size-3 shrink-0", PRIORITY_FLAG_CLASS_NAME[priority])}
        />
      ) : null}
      {favorite ? (
        <StarIcon aria-label="Favorite" className="size-3 shrink-0 fill-current text-warning" />
      ) : null}
    </>
  );
}

import { hubWriteEnvironment } from "@t3tools/client-runtime/codrHub/projectPickerModel";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { HubMergedProjectView } from "@t3tools/contracts";
import { useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { HubProjectPatch } from "./hubProjectMenu";
import type { useHubPortfolio } from "./useHubPortfolio";

/** Project edits that show at once; saving commits to the portfolio repo before the snapshot catches up. */
export function useHubProjectEdits(portfolio: ReturnType<typeof useHubPortfolio>) {
  const upsertProject = useAtomCommand(serverEnvironment.hubUpsertProject, {
    reportFailure: false,
  });
  const [pendingEdits, setPendingEdits] = useState<ReadonlyMap<string, HubProjectPatch>>(new Map());

  const projects =
    pendingEdits.size === 0
      ? portfolio.projects
      : portfolio.projects.map((view) => {
          const edit = pendingEdits.get(view.project.id);
          return edit ? { ...view, project: { ...view.project, ...edit } } : view;
        });

  const editProject = async (view: HubMergedProjectView, edit: HubProjectPatch) => {
    const environmentId = hubWriteEnvironment(view, portfolio.nodeNameByEnvironmentId, null);
    if (environmentId === null) {
      Dialog.alert(
        `Could not update ${view.project.name}`,
        "No connected machine has this project.",
      );
      return;
    }
    const { id } = view.project;
    setPendingEdits((current) => new Map(current).set(id, { ...current.get(id), ...edit }));
    const result = await upsertProject({ environmentId, input: { id, ...edit } });
    setPendingEdits((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      Dialog.alert(
        `Could not update ${view.project.name}`,
        failure instanceof Error ? failure.message : "The request failed.",
      );
    }
  };

  return { projects, editProject };
}

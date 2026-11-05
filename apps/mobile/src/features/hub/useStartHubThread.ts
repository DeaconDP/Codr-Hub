import {
  hubThreadTarget,
  type HubThreadTarget,
} from "@t3tools/client-runtime/codrHub/projectPickerModel";
import { buildProjectCreateCommand } from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  type EnvironmentId,
  type HubMergedProjectView,
  ProjectId,
} from "@t3tools/contracts";
import { useRef } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { useProjects, waitForProject } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { useSelectWorkspaceTab } from "../workspace/useSelectWorkspaceTab";

type Target = HubThreadTarget<{ readonly environmentId: EnvironmentId; readonly id: ProjectId }>;

/** The accessibility suffix for what tapping a Hub project's thread action does. */
export function hubThreadActionLabel(target: Target): string {
  switch (target.kind) {
    case "open":
      return "start a task";
    case "add":
      return "add project and start a task";
    case "unavailable":
      return "not on a connected machine";
  }
}

/**
 * Opens a new-thread draft from the Hub tab. A portfolio project without a T3
 * project is offered as one to add on the machine that has its folder.
 */
export function useStartHubThread(nodeNameByEnvironmentId: ReadonlyMap<EnvironmentId, string>) {
  const selectDetail = useSelectWorkspaceDetail();
  const selectTab = useSelectWorkspaceTab();
  const projects = useProjects();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const adding = useRef(false);

  const open = (environmentId: EnvironmentId, projectId: ProjectId) => {
    // A thread belongs to Chats; page tabs keep their tab bar over a pushed detail.
    selectTab("threads");
    selectDetail({
      name: "Thread",
      params: { draft: { environmentId: String(environmentId), projectId: String(projectId) } },
    });
  };

  const addProject = async (
    name: string,
    target: Extract<Target, { kind: "add" }>,
  ): Promise<void> => {
    const projectId = ProjectId.make(uuidv4());
    const result = await createProject({
      environmentId: target.environmentId,
      input: buildProjectCreateCommand({
        commandId: CommandId.make(uuidv4()),
        projectId,
        workspaceRoot: target.workspaceRoot,
      }),
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      Dialog.alert(
        `Could not add ${name}`,
        failure instanceof Error ? failure.message : "The request failed.",
      );
      return;
    }
    // The command can commit before the project reaches this device's store.
    const project = await waitForProject(
      { environmentId: target.environmentId, projectId },
      15_000,
    );
    if (project === null) {
      Dialog.alert(
        "Project added",
        "It has not reached this device yet. Try again once the connection catches up.",
      );
      return;
    }
    open(target.environmentId, projectId);
  };

  const addAndOpen = (name: string, target: Extract<Target, { kind: "add" }>) => {
    if (adding.current) return;
    adding.current = true;
    void addProject(name, target).finally(() => {
      adding.current = false;
    });
  };

  const targetFor = (view: HubMergedProjectView): Target =>
    hubThreadTarget(view, projects, nodeNameByEnvironmentId);

  const start = (view: HubMergedProjectView, target: Target = targetFor(view)) => {
    const { name } = view.project;
    switch (target.kind) {
      case "open":
        open(target.project.environmentId, target.project.id);
        return;
      case "unavailable":
        Dialog.alert(
          `${name} isn't on a connected machine`,
          target.nodeNames.length > 0
            ? `Connect ${target.nodeNames.join(" or ")} to start a thread in it.`
            : "No machine has this project's folder checked out.",
        );
        return;
      case "add":
        if (!readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope)) {
          Dialog.alert(
            `Can't add ${name}`,
            `This device doesn't have permission to add projects on ${target.nodeName}.`,
          );
          return;
        }
        Dialog.confirm({
          title: `Add ${name} as a project?`,
          message: `${target.workspaceRoot} on ${target.nodeName} isn't a project yet. Add it to start a thread.`,
          confirmText: "Add and start",
          onConfirm: () => addAndOpen(name, target),
        });
    }
  };

  return { targetFor, start };
}

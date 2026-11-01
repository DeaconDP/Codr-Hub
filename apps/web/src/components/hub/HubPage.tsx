import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { isElectron } from "../../env";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { HubPacePanel } from "./HubPacePanel";
import { HubProjectsTable } from "./HubProjectsTable";
import { HubTestQueue } from "./HubTestQueue";
import { HubSettingsPanel } from "./HubSettingsPanel";
import { HubStrategyPanel } from "./HubStrategyPanel";
import { useEscapeToGoBack } from "./useEscapeToGoBack";
import { useHubAction } from "./useHubAction";

/** Codr-Hub: the portfolio, strategy, and autopilot. The table unions connected nodes. */
export function HubPage() {
  useEscapeToGoBack();
  useNowMinute(); // re-render relative times each minute
  const { environments } = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const [chosenId, setChosenId] = useState<EnvironmentId | null>(null);
  const environment =
    connected.find((entry) => entry.environmentId === chosenId) ??
    connected.find((entry) => entry.environmentId === primaryId) ??
    connected[0] ??
    null;
  const hub = useEnvironmentQuery(
    environment
      ? serverEnvironment.hubLive({ environmentId: environment.environmentId, input: {} })
      : null,
  );
  const connectedKey = JSON.stringify(connected.map((entry) => entry.environmentId));
  const merged = useAtomValue(
    connected.length === 0
      ? serverEnvironment.hubMergedProjectsEmpty
      : serverEnvironment.hubMergedProjects(connectedKey),
  );
  const snapshot = hub.data;
  const tableSnapshot = snapshot ?? merged.anySnapshot;

  const header = (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-2">
      <WorkspaceBreadcrumb ariaLabel="Hub breadcrumb" className="min-w-0">
        <WorkspaceBreadcrumbItem>
          <h1>Hub</h1>
        </WorkspaceBreadcrumbItem>
        {environment ? (
          <>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="min-w-10">
              {connected.length > 1 ? (
                <Select
                  value={environment.environmentId}
                  onValueChange={(next) => next && setChosenId(next as EnvironmentId)}
                >
                  <SelectTrigger size="compact" variant="ghost" aria-label="Environment">
                    <SelectValue>{snapshot?.nodeName ?? environment.label}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {connected.map((entry) => (
                      <SelectItem key={entry.environmentId} value={entry.environmentId}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : (
                <span>{snapshot?.nodeName ?? environment.label}</span>
              )}
            </WorkspaceBreadcrumbItem>
          </>
        ) : null}
      </WorkspaceBreadcrumb>
      <Button size="xs" variant="ghost-muted" render={<Link to="/hub/dashboard" />}>
        Dashboard
      </Button>
      {environment && snapshot ? (
        <AutopilotSwitch
          environmentId={environment.environmentId}
          enabled={snapshot.autopilotEnabled}
        />
      ) : null}
    </div>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          {header}
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {!environment ? (
              <p className="text-sm text-muted-foreground">
                Connect an environment to open the hub.
              </p>
            ) : hub.error && tableSnapshot === null ? (
              <div role="alert" className="flex flex-col items-start gap-2 text-sm">
                <p>Could not load the hub on {environment.label}.</p>
                <p className="text-muted-foreground">{hub.error}</p>
                <Button size="xs" variant="outline" onClick={hub.refresh}>
                  Try again
                </Button>
              </div>
            ) : tableSnapshot === null ? (
              <div className="flex flex-col gap-3" role="status" aria-label="Loading hub">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-64 w-full" />
              </div>
            ) : (
              <div className="flex flex-col gap-8">
                {snapshot?.fleet && snapshot.fleet.phase !== "current" ? (
                  <p
                    role="status"
                    className={
                      snapshot.fleet.phase === "stuck"
                        ? "text-sm text-foreground"
                        : "text-sm text-muted-foreground"
                    }
                  >
                    {snapshot.fleet.detail}
                  </p>
                ) : null}
                <HubTestQueue
                  environmentId={environment.environmentId}
                  projects={merged.projects}
                />
                {snapshot ? (
                  <HubPacePanel
                    environmentId={environment.environmentId}
                    pace={snapshot.pace}
                    note={snapshot.autopilotNote}
                  />
                ) : hub.error ? (
                  <p role="alert" className="text-sm text-muted-foreground">
                    Could not load pace on {environment.label}. {hub.error} Projects from other
                    connected environments are still listed.
                  </p>
                ) : (
                  <Skeleton className="h-16 w-full" />
                )}
                <HubProjectsTable
                  environmentId={environment.environmentId}
                  snapshot={tableSnapshot}
                  projects={merged.projects}
                  selectedNodeName={snapshot?.nodeName ?? ""}
                />
                {snapshot ? (
                  <div className="grid gap-10 lg:grid-cols-2">
                    <HubStrategyPanel
                      environmentId={environment.environmentId}
                      snapshot={snapshot}
                    />
                    <HubSettingsPanel
                      environmentId={environment.environmentId}
                      snapshot={snapshot}
                    />
                  </div>
                ) : null}
              </div>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function AutopilotSwitch(props: { environmentId: EnvironmentId; enabled: boolean }) {
  const setNode = useHubAction(
    serverEnvironment.hubSetNode,
    props.environmentId,
    "Could not change the autopilot",
  );
  return (
    <label className="ms-auto flex min-h-11 items-center gap-2 text-sm">
      <Switch
        aria-label="Autopilot"
        checked={props.enabled}
        disabled={setNode.busy}
        aria-busy={setNode.busy}
        onCheckedChange={(checked) => void setNode.run({ autopilotEnabled: checked })}
      />
      Autopilot
    </label>
  );
}

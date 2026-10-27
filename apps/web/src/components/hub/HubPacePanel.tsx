import type { EnvironmentId, HubPace } from "@t3tools/contracts";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { formatRelativeTimeUntilLabel } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { PACE_STATE } from "./hubFormat";
import { useHubAction } from "./useHubAction";

export function HubPacePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly pace: ReadonlyArray<HubPace>;
  readonly note: string | null;
}) {
  if (props.pace.length === 0 && props.note === null) {
    return (
      <p className="text-sm text-muted-foreground">
        No providers are enabled. Turn one on in Settings → Providers.
      </p>
    );
  }
  return (
    <section aria-label="Subscription pace" className="flex flex-col">
      {props.note ? (
        <p role="status" className="pb-2 text-sm text-muted-foreground">
          {props.note}
        </p>
      ) : null}
      <ul className="flex flex-col divide-y border-y">
        {props.pace.map((entry) => (
          <HubPaceRow key={entry.instanceId} environmentId={props.environmentId} pace={entry} />
        ))}
      </ul>
      {props.pace.length > 0 ? <RunOnce environmentId={props.environmentId} /> : null}
    </section>
  );
}

function RunOnce(props: { environmentId: EnvironmentId }) {
  const runOnce = useHubAction(
    serverEnvironment.hubRunAutopilot,
    props.environmentId,
    "Autopilot run failed",
  );
  return (
    <div className="pt-2">
      <Button
        size="sm"
        variant="ghost-muted"
        disabled={runOnce.busy}
        aria-busy={runOnce.busy}
        onClick={() => void runOnce.run({})}
      >
        {runOnce.busy ? "Launching…" : "Run once"}
      </Button>
    </div>
  );
}

function paceSummary(pace: HubPace) {
  const state = PACE_STATE[pace.state];
  if (pace.usedPercent === null) return state;
  const used = `${Math.round(pace.usedPercent)}%`;
  const target =
    pace.state === "behind" && pace.targetPercent !== null
      ? ` of ${Math.round(pace.targetPercent)}%`
      : "";
  const reset = pace.resetsAt ? ` · resets ${formatRelativeTimeUntilLabel(pace.resetsAt)}` : "";
  return `${used}${target} · ${state}${reset}`;
}

function HubPaceRow({ environmentId, pace }: { environmentId: EnvironmentId; pace: HubPace }) {
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <ProviderInstanceIcon
          driverKind={pace.driver}
          displayName={pace.label}
          iconClassName="size-4"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{pace.label}</p>
          <p className="text-sm text-muted-foreground">{paceSummary(pace)}</p>
        </div>
      </div>
      {pace.state !== "on_pace" ? (
        <p className="text-sm text-muted-foreground">{pace.reason}</p>
      ) : null}
      {pace.bankedResets > 0 ? <BankedResets environmentId={environmentId} pace={pace} /> : null}
    </li>
  );
}

/** Redeeming is irreversible, so it takes a second, explicit confirmation. */
function BankedResets({ environmentId, pace }: { environmentId: EnvironmentId; pace: HubPace }) {
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const deploy = useHubAction(
    serverEnvironment.consumeResetCredit,
    environmentId,
    "Could not deploy the banked reset",
  );
  const redeem = async () => {
    setConfirming(false);
    const result = await deploy.run({ instanceId: pace.instanceId });
    if (result) setOutcome(result.warning ?? "Reset deployed.");
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 text-sm text-muted-foreground">
        {pace.bankedResets} banked reset{pace.bankedResets === 1 ? "" : "s"}
        {pace.bankedResetExpiresAt
          ? ` · expires ${formatRelativeTimeUntilLabel(pace.bankedResetExpiresAt)}`
          : ""}
      </span>
      {confirming ? (
        <>
          <Button size="sm" variant="ghost-muted" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={deploy.busy}
            aria-busy={deploy.busy}
            onClick={() => void redeem()}
          >
            {deploy.busy ? "Deploying…" : "Deploy now"}
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={deploy.busy}
          onClick={() => setConfirming(true)}
        >
          Deploy reset
        </Button>
      )}
      {outcome ? (
        <p role="status" className="w-full text-sm text-muted-foreground">
          {outcome}
        </p>
      ) : null}
    </div>
  );
}

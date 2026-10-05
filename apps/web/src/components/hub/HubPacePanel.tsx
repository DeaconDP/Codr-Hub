import type { EnvironmentId, HubPace } from "@t3tools/contracts";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { formatRelativeTimeUntilLabel } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { PACE_STATE } from "./hubFormat";
import { useHubAction } from "./useHubAction";

export function HubPacePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly pace: ReadonlyArray<HubPace>;
  readonly note: string | null;
}) {
  return (
    <section aria-labelledby="hub-pace-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="hub-pace-heading" className="text-sm font-medium text-foreground">
          Subscription pace
        </h2>
        {props.note ? (
          <p role="status" className="text-xs text-muted-foreground">
            {props.note}
          </p>
        ) : null}
      </div>
      {props.pace.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No providers are enabled on this environment. Enable one in Settings → Providers.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {props.pace.map((entry) => (
            <HubPaceCard key={entry.instanceId} environmentId={props.environmentId} pace={entry} />
          ))}
        </ul>
      )}
    </section>
  );
}

function HubPaceCard({ environmentId, pace }: { environmentId: EnvironmentId; pace: HubPace }) {
  const state = PACE_STATE[pace.state];
  const used = pace.usedPercent ?? 0;
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3">
      <div className="flex min-w-0 items-center gap-2">
        <ProviderInstanceIcon
          driverKind={pace.driver}
          displayName={pace.label}
          iconClassName="size-4"
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{pace.label}</span>
        <Badge variant={state.variant}>{state.label}</Badge>
      </div>
      {pace.usedPercent !== null ? (
        <>
          <div
            role="meter"
            aria-label={`${pace.windowLabel ?? "Usage"} used`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(used)}
            aria-valuetext={`${Math.round(used)}% used${
              pace.targetPercent !== null ? `, target ${Math.round(pace.targetPercent)}%` : ""
            }`}
            className="relative h-2 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.min(100, used)}%` }}
            />
            {pace.targetPercent !== null ? (
              <div
                aria-hidden
                className="absolute top-0 h-full w-0.5 bg-foreground/70"
                style={{ left: `${Math.min(100, pace.targetPercent)}%` }}
              />
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">
            {pace.windowLabel}: {Math.round(used)}% used
            {pace.targetPercent !== null ? ` · target ${Math.round(pace.targetPercent)}%` : ""}
            {pace.resetsAt ? ` · resets ${formatRelativeTimeUntilLabel(pace.resetsAt)}` : ""}
          </p>
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {pace.reason}
        {pace.state === "behind"
          ? ` Wants ${pace.desiredConcurrency} run${pace.desiredConcurrency === 1 ? "" : "s"}, ${pace.running} running.`
          : ""}
      </p>
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
    if (result) setOutcome(result.warning ?? `Result: ${result.outcome}.`);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-t pt-2 text-xs">
      <span className="min-w-0 flex-1 text-muted-foreground">
        {pace.bankedResets} banked reset{pace.bankedResets === 1 ? "" : "s"}
        {pace.bankedResetExpiresAt
          ? ` · next expires ${formatRelativeTimeUntilLabel(pace.bankedResetExpiresAt)}`
          : ""}
      </span>
      {confirming ? (
        <>
          <Button size="xs" variant="ghost-muted" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button size="xs" disabled={deploy.busy} onClick={() => void redeem()}>
            Deploy now
          </Button>
        </>
      ) : (
        <Button
          size="xs"
          variant="outline"
          disabled={deploy.busy}
          onClick={() => setConfirming(true)}
        >
          Deploy reset
        </Button>
      )}
      {outcome ? (
        <p role="status" className="w-full text-muted-foreground">
          {outcome}
        </p>
      ) : null}
    </div>
  );
}

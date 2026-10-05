import {
  HUB_DEFAULT_STAGE_PROMPTS,
  HUB_STAGE_LABELS,
  type EnvironmentId,
  type HubSdlcStage,
  type HubSnapshot,
} from "@t3tools/contracts";
import { useId, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { useHubAction } from "./useHubAction";

export function HubSettingsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: HubSnapshot;
}) {
  const { snapshot, environmentId } = props;
  const { settings, sync } = snapshot;
  const id = useId();
  const update = useHubAction(
    serverEnvironment.hubUpdateSettings,
    environmentId,
    "Could not save hub settings",
  );
  const setNode = useHubAction(
    serverEnvironment.hubSetNode,
    environmentId,
    "Could not rename node",
  );
  const runSync = useHubAction(serverEnvironment.hubSync, environmentId, "Could not sync");
  const [remote, setRemote] = useState(sync.remote ?? "");

  /** Commits a numeric field on blur when it is a valid, changed value. */
  const commitNumber = (
    raw: string,
    current: number,
    range: { min: number; max: number },
    apply: (value: number) => void,
  ) => {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= range.min && value <= range.max && value !== current) {
      apply(value);
    }
  };
  const blurOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") event.currentTarget.blur();
  };

  return (
    <section aria-labelledby="hub-settings-heading" className="flex flex-col gap-4">
      <h2 id="hub-settings-heading" className="text-sm font-medium text-foreground">
        Hub settings
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-node`}>This node’s name</Label>
          <Input
            id={`${id}-node`}
            size="compact"
            defaultValue={snapshot.nodeName}
            key={snapshot.nodeName}
            onBlur={(event) => {
              const next = event.target.value.trim();
              if (next !== "" && next !== snapshot.nodeName) void setNode.run({ nodeName: next });
            }}
            onKeyDown={blurOnEnter}
          />
          <p className="text-xs text-muted-foreground">
            Checkouts are stored per node. Renaming carries this node’s paths over.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium" id={`${id}-mode`}>
            SDLC stages
          </span>
          <ToggleGroup
            aria-labelledby={`${id}-mode`}
            variant="segmented"
            value={[settings.sdlcMode]}
            onValueChange={(next) => {
              const mode = next[0];
              if ((mode === "three" || mode === "six") && mode !== settings.sdlcMode) {
                void update.run({ sdlcMode: mode });
              }
            }}
          >
            <Toggle value="three">3 stages</Toggle>
            <Toggle value="six">6 stages</Toggle>
          </ToggleGroup>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-target`}>Spend target before reset (%)</Label>
          <Input
            id={`${id}-target`}
            size="compact"
            type="number"
            min={10}
            max={100}
            defaultValue={settings.paceTargetPercent}
            key={settings.paceTargetPercent}
            onBlur={(event) =>
              commitNumber(
                event.target.value,
                settings.paceTargetPercent,
                { min: 10, max: 100 },
                (value) => void update.run({ paceTargetPercent: value }),
              )
            }
            onKeyDown={blurOnEnter}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-runs`}>Max autopilot runs at once</Label>
          <Input
            id={`${id}-runs`}
            size="compact"
            type="number"
            min={1}
            max={8}
            defaultValue={settings.maxConcurrentRuns}
            key={settings.maxConcurrentRuns}
            onBlur={(event) =>
              commitNumber(
                event.target.value,
                settings.maxConcurrentRuns,
                { min: 1, max: 8 },
                (value) => void update.run({ maxConcurrentRuns: Math.round(value) }),
              )
            }
            onKeyDown={blurOnEnter}
          />
        </div>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <Switch
          aria-label="Deploy banked resets automatically"
          checked={settings.autoDeployBankedResets}
          onCheckedChange={(checked) => void update.run({ autoDeployBankedResets: checked })}
        />
        <span>
          Deploy banked resets automatically
          <span className="block text-xs text-muted-foreground">
            Only when a provider is capped and its next banked reset would expire before the cap
            lifts. You can always deploy one by hand above.
          </span>
        </span>
      </label>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-remote`}>Portfolio git remote</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            id={`${id}-remote`}
            size="compact"
            className="min-w-0 flex-1"
            placeholder="git@github.com:you/codr-hub-portfolio.git"
            value={remote}
            onChange={(event) => setRemote(event.target.value)}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={runSync.busy}
            onClick={() =>
              void runSync.run({ remote: remote.trim() === "" ? null : remote.trim() })
            }
          >
            {runSync.busy ? "Syncing…" : "Save & sync"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Use a private repo. Stored at <code className="break-all">{sync.portfolioPath}</code>.{" "}
          {sync.lastError ? (
            <span className="text-destructive-foreground">Last sync failed: {sync.lastError}</span>
          ) : sync.lastSyncAt ? (
            `Last synced ${formatRelativeTimeLabel(sync.lastSyncAt)}.`
          ) : sync.remote ? (
            "Not synced yet."
          ) : (
            "Local only until a remote is set."
          )}
        </p>
      </div>

      <details className="rounded-lg border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">Stage prompts</summary>
        <p className="mt-2 text-xs text-muted-foreground">
          What the autopilot asks for at each stage. Leave a box empty to use the built-in prompt.
        </p>
        <div className="mt-3 flex flex-col gap-3">
          {(Object.keys(HUB_STAGE_LABELS) as HubSdlcStage[]).map((stage) => (
            <div key={stage} className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-prompt-${stage}`}>{HUB_STAGE_LABELS[stage]}</Label>
              <Textarea
                id={`${id}-prompt-${stage}`}
                placeholder={HUB_DEFAULT_STAGE_PROMPTS[stage]}
                defaultValue={settings.stagePrompts[stage] ?? ""}
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  if (value === (settings.stagePrompts[stage] ?? "")) return;
                  const { [stage]: _previous, ...rest } = settings.stagePrompts;
                  void update.run({
                    stagePrompts: value === "" ? rest : { ...rest, [stage]: value },
                  });
                }}
              />
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}

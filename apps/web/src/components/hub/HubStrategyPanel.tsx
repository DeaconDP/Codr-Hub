import type { EnvironmentId, HubSnapshot, HubStrategyPriority } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { newStrategyId } from "./hubFormat";
import { useHubAction } from "./useHubAction";

/**
 * The ordered priority list. Order is rank: the autopilot works on projects
 * linked to the first priority before the second.
 */
export function HubStrategyPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: HubSnapshot;
}) {
  const { strategy, projects } = props.snapshot;
  const [title, setTitle] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const save = useHubAction(
    serverEnvironment.hubSetStrategy,
    props.environmentId,
    "Could not update the strategy",
  );
  const write = (next: ReadonlyArray<HubStrategyPriority>) => save.run({ strategy: [...next] });

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed === "" || save.busy) return;
    const ok = await write([
      ...strategy,
      { id: newStrategyId(trimmed, randomUUID()), title: trimmed, notes: "" },
    ]);
    if (ok) setTitle("");
  };
  const move = (index: number, delta: -1 | 1) => {
    const next = [...strategy];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    void write(next);
  };
  const rename = (id: string, value: string) => {
    const trimmed = value.trim();
    const current = strategy.find((priority) => priority.id === id);
    if (!current || trimmed === "" || trimmed === current.title) return;
    void write(
      strategy.map((priority) => (priority.id === id ? { ...priority, title: trimmed } : priority)),
    );
  };
  const remove = (id: string) => {
    setConfirmRemove(null);
    void write(strategy.filter((priority) => priority.id !== id));
  };
  const linked = (id: string) => projects.filter((view) => view.project.strategyId === id).length;

  return (
    <section aria-labelledby="hub-strategy-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="hub-strategy-heading" className="text-sm font-medium text-foreground">
          Strategy
        </h2>
        <p className="text-xs text-muted-foreground">
          Specific priorities, most important first. Linked projects outrank everything else.
        </p>
      </div>
      {strategy.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No priorities yet. Add one, such as “Ship Emily-OS v1”, then link projects to it.
        </p>
      ) : (
        <ol className="flex flex-col divide-y rounded-lg border">
          {strategy.map((priority, index) => (
            <li key={priority.id} className="flex items-center gap-2 px-2 py-1.5">
              <span className="w-5 text-center text-xs text-muted-foreground tabular-nums">
                {index + 1}
              </span>
              <Input
                size="compact"
                aria-label={`Priority ${index + 1} title`}
                defaultValue={priority.title}
                key={priority.title}
                className="min-w-0 flex-1"
                onBlur={(event) => rename(priority.id, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              <span className="hidden text-xs text-muted-foreground sm:inline">
                {linked(priority.id)} project{linked(priority.id) === 1 ? "" : "s"}
              </span>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Move ${priority.title} up`}
                disabled={index === 0 || save.busy}
                onClick={() => move(index, -1)}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Move ${priority.title} down`}
                disabled={index === strategy.length - 1 || save.busy}
                onClick={() => move(index, 1)}
              >
                <ArrowDownIcon />
              </Button>
              {confirmRemove === priority.id ? (
                <>
                  <Button size="xs" variant="ghost-muted" onClick={() => setConfirmRemove(null)}>
                    Keep
                  </Button>
                  <Button size="xs" variant="destructive" onClick={() => remove(priority.id)}>
                    Remove
                  </Button>
                </>
              ) : (
                <Button
                  size="icon-xs"
                  variant="ghost-destructive"
                  aria-label={`Remove ${priority.title}`}
                  onClick={() => setConfirmRemove(priority.id)}
                >
                  <XIcon />
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
      <form onSubmit={(event) => void add(event)} className="flex gap-2">
        <Input
          size="compact"
          aria-label="New priority"
          placeholder="New priority"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Button size="xs" type="submit" disabled={title.trim() === "" || save.busy}>
          Add
        </Button>
      </form>
    </section>
  );
}

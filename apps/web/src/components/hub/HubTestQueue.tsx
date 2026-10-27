import type { EnvironmentId, HubMergedProjectView } from "@t3tools/contracts";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useHubAction } from "./useHubAction";

export function HubTestQueue(props: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<HubMergedProjectView>;
}) {
  const rows = props.projects.flatMap((view) => {
    const handoff = view.handoff;
    if (handoff?.kind === "ready" || handoff?.kind === "fix") {
      return [{ project: view.project, handoff }];
    }
    return [];
  });
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="hub-test-queue-heading" className="flex flex-col gap-1">
      <h2 id="hub-test-queue-heading" className="text-sm font-medium text-foreground">
        Needs you
      </h2>
      <ul className="flex flex-col divide-y border-y">
        {rows.map((row) => (
          <li key={row.project.id} className="py-3">
            <TestQueueRow
              environmentId={props.environmentId}
              projectId={row.project.id}
              projectName={row.project.name}
              handoff={row.handoff}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function TestQueueRow(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly projectName: string;
  readonly handoff: Extract<HubMergedProjectView["handoff"], { kind: "ready" | "fix" }>;
}) {
  const verdict = useHubAction(
    serverEnvironment.hubRecordTestVerdict,
    props.environmentId,
    "Could not record the verdict",
  );
  const [fixing, setFixing] = useState(false);
  const [note, setNote] = useState("");
  if (props.handoff.kind === "fix") {
    return (
      <p className="text-sm">
        <span className="font-medium">{props.projectName}</span>
        <span className="text-muted-foreground"> {props.handoff.note}</span>
      </p>
    );
  }
  const trimmed = note.trim();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{props.projectName}</span>
        <Button
          size="sm"
          type="button"
          disabled={verdict.busy}
          aria-busy={verdict.busy}
          onClick={() => void verdict.run({ projectId: props.projectId, verdict: "ship" })}
        >
          {verdict.busy ? "Saving…" : "Ship"}
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          aria-expanded={fixing}
          disabled={verdict.busy}
          onClick={() => setFixing((current) => !current)}
        >
          Fix
        </Button>
      </div>
      {fixing ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed === "" || verdict.busy) return;
            void verdict.run({ projectId: props.projectId, verdict: "fix", note: trimmed });
          }}
        >
          <Input
            aria-label={`Fix note for ${props.projectName}`}
            placeholder="What should change?"
            maxLength={500}
            value={note}
            disabled={verdict.busy}
            onChange={(event) => setNote(event.target.value)}
            className="min-w-0 flex-1"
          />
          <Button
            size="sm"
            type="submit"
            disabled={verdict.busy || trimmed === ""}
            aria-busy={verdict.busy}
          >
            {verdict.busy ? "Sending…" : "Send"}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

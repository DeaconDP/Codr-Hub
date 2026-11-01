import type { EnvironmentId, HubUpstreamMergeResult, HubUpstreamStatus } from "@t3tools/contracts";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { useHubAction } from "./useHubAction";

const commits = (count: number) => `${count} commit${count === 1 ? "" : "s"}`;

/** Why Merge & push is disabled, or `null` when it can run. */
function mergeBlocker(status: HubUpstreamStatus | null): string | null {
  if (status === null) return "Check first.";
  if (status._tag === "Unavailable") return status.reason;
  if (status.operationInProgress) return "Finish or abort the unfinished git operation first.";
  if (!status.clean) return "Commit or stash the checkout's local changes first.";
  if (status.branch === null) return "The checkout is not on a branch.";
  if (status.behind === 0) return "Already up to date with T3 Code.";
  return null;
}

function resultText(result: HubUpstreamMergeResult): string {
  switch (result._tag) {
    case "UpToDate":
      return "Already up to date with T3 Code.";
    case "Merged":
      return result.pushError === null
        ? `Merged ${commits(result.merged)} and pushed ${result.branch}. Fleet nodes update when idle.`
        : `Merged ${commits(result.merged)} locally, but the push failed: ${result.pushError}`;
    case "Conflict":
      return "The merge conflicts and was aborted. Nothing changed. Merge by hand to resolve:";
  }
}

/** "Update from T3 Code": merge upstream/main into this server's checkout and push to origin. */
export function HubUpstreamRow(props: { readonly environmentId: EnvironmentId }) {
  const check = useHubAction(
    serverEnvironment.hubUpstreamStatus,
    props.environmentId,
    "Could not check T3 Code",
  );
  const merge = useHubAction(
    serverEnvironment.hubUpstreamMerge,
    props.environmentId,
    "Could not update from T3 Code",
  );
  const [status, setStatus] = useState<HubUpstreamStatus | null>(null);
  const [result, setResult] = useState<HubUpstreamMergeResult | null>(null);

  const runCheck = async () => {
    const next = await check.run({});
    if (next !== null) setStatus(next);
  };
  const runMerge = async () => {
    setResult(null);
    const next = await merge.run({});
    if (next === null) return;
    setResult(next);
    await runCheck();
  };

  const blocker = mergeBlocker(status);
  const busy = check.busy || merge.busy;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">Update from T3 Code</span>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-sm text-muted-foreground">
          {status === null
            ? "Not checked yet."
            : status._tag === "Unavailable"
              ? "Unavailable."
              : status.behind === 0
                ? "Up to date with T3 Code."
                : `${commits(status.behind)} behind T3 Code.`}
        </span>
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void runCheck()}>
          {check.busy ? "Checking…" : "Check"}
        </Button>
        <Button size="xs" disabled={busy || blocker !== null} onClick={() => void runMerge()}>
          {merge.busy ? "Merging…" : "Merge & push"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Merges T3 Code's main branch into this server's checkout and pushes it to origin, where
        fleet nodes pick it up. {status !== null && blocker !== null ? blocker : null}
        {status !== null
          ? ` Checked ${formatRelativeTimeLabel(new Date(status.checkedAtMs).toISOString())}.`
          : null}
      </p>
      {result !== null ? (
        <div
          className={
            result._tag === "Conflict" || (result._tag === "Merged" && result.pushError !== null)
              ? "text-xs text-destructive-foreground"
              : "text-xs text-muted-foreground"
          }
        >
          <p>{resultText(result)}</p>
          {result._tag === "Conflict" ? (
            <ul className="mt-1 list-disc pl-4">
              {result.files.map((file) => (
                <li key={file}>
                  <code className="break-all">{file}</code>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

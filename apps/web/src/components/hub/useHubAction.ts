import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Runs one hub command against `environmentId` and toasts a plain message on
 * failure. Resolves to the value on success and `null` otherwise; `busy`
 * lets callers block duplicate submits.
 */
export function useHubAction<I, A, E>(
  command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: I }, A, E>,
  environmentId: EnvironmentId,
  failureTitle: string,
) {
  const execute = useAtomCommand(command, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (input: I): Promise<A | null> => {
      setBusy(true);
      const result = await execute({ environmentId, input });
      setBusy(false);
      if (result._tag === "Success") return result.value;
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: failureTitle,
            description: failure instanceof Error ? failure.message : "The request failed.",
          }),
        );
      }
      return null;
    },
    [environmentId, execute, failureTitle],
  );
  return { run, busy };
}

import { joinTailnetHost } from "@t3tools/client-runtime/codrHub/linkTailnetMesh";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../state/atom-registry";
import type { PairingOutcome } from "../state/use-remote-environment-registry";
import { connectionAtomRuntime } from "./runtime";

const joinTailnet = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:codr-hub:join-tailnet",
  scheduler: createAtomCommandScheduler(),
  concurrency: { mode: "singleFlight", key: (host: string) => host },
  execute: (host: string) => joinTailnetHost(host),
});

/** Saves one tailnet machine with no pairing code; the mesh layer then syncs the rest. */
export async function joinTailnetEnvironment(host: string): Promise<PairingOutcome> {
  const result = await runAtomCommand(appAtomRegistry, joinTailnet, host, {
    reportFailure: false,
  });
  if (AsyncResult.isSuccess(result)) return { ok: true, error: null };
  const error = Cause.squash(result.cause);
  const detail =
    error !== null && typeof error === "object" && "detail" in error ? error.detail : null;
  return {
    ok: false,
    error: typeof detail === "string" ? detail : "Couldn't join that machine over Tailscale.",
  };
}

import { WS_METHODS, type EnvironmentId, type HubLinkTailnetResult } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionCatalogEntry,
} from "../connection/catalog.ts";
import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import { BearerConnectionTarget, ConnectionBlockedError } from "../connection/model.ts";
import {
  deriveWsBaseUrl,
  environmentEndpointUrl,
  normalizeHttpBaseUrl,
} from "../environment/endpoint.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { bearerConnectionId } from "../connection/onboarding.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import {
  connectionRouteId,
  connectionRouteKind,
  connectionRoutes,
  routeHttpBaseUrl,
} from "../connection/routes.ts";
import { request } from "../rpc/client.ts";

export interface SavedTailnetRoute {
  readonly environmentId: string;
  readonly origin: string;
  readonly token: string;
}

function originOf(httpBaseUrl: string): string | null {
  try {
    return new URL(httpBaseUrl).origin;
  } catch {
    return null;
  }
}

/** Skip register when this client already has the same environment, origin, and token. */
export function catalogDecision(
  saved: readonly SavedTailnetRoute[],
  link: {
    readonly environmentId: string;
    readonly httpBaseUrl: string;
    readonly accessToken: string;
  },
): "skip" | "save" {
  const origin = originOf(link.httpBaseUrl);
  if (origin === null) return "save";
  const already = saved.some(
    (route) =>
      route.environmentId === link.environmentId &&
      route.origin === origin &&
      route.token === link.accessToken,
  );
  return already ? "skip" : "save";
}

/** Codr-Hub's dev share port, which the server's mesh also probes on every peer. */
const CODR_HUB_PORT = 5733;

/**
 * Codr-Hub origins to try on tailnet machines this client already saved, such as a stock
 * T3 connection to a machine that also runs Codr-Hub. Origins already saved are skipped.
 */
export function codrHubProbeOrigins(savedOrigins: readonly string[]): readonly string[] {
  const probes: string[] = [];
  for (const saved of savedOrigins) {
    let host: string;
    try {
      host = new URL(saved).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!host.endsWith(".ts.net")) continue;
    const probe = `https://${host}:${CODR_HUB_PORT}`;
    if (!savedOrigins.includes(probe) && !probes.includes(probe)) probes.push(probe);
  }
  return probes;
}

function introducerRank(entry: ConnectionCatalogEntry): number {
  const routes = connectionRoutes(entry);
  if (routes.some((route) => route.target._tag === "PrimaryConnectionTarget")) return 0;
  if (routes.some((route) => connectionRouteKind(route) === "loopback")) return 1;
  return 2;
}

/** Connected environments, best introducer first. Stock T3 servers are among them. */
const connectedIntroducers = Effect.fn("codrHub.linkTailnetMesh.introducers")(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const entries = yield* SubscriptionRef.get(registry.entries);
  const connected: { readonly id: EnvironmentId; readonly rank: number }[] = [];
  for (const [id, entry] of entries) {
    if (!entry.enabled) continue;
    const state = yield* registry.state(id).pipe(Effect.option);
    if (Option.isNone(state) || state.value.phase !== "connected") continue;
    connected.push({ id, rank: introducerRank(entry) });
  }
  return connected.sort((a, b) => a.rank - b.rank).map(({ id }) => id);
});

const savedRoutes = Effect.fn("codrHub.linkTailnetMesh.savedRoutes")(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const entries = yield* SubscriptionRef.get(registry.entries);
  const saved: SavedTailnetRoute[] = [];
  for (const [environmentId, entry] of entries) {
    for (const route of connectionRoutes(entry)) {
      const httpBaseUrl = routeHttpBaseUrl(route);
      if (httpBaseUrl === null) continue;
      const origin = originOf(httpBaseUrl);
      if (origin === null) continue;
      const credential = yield* credentials
        .get(connectionRouteId(route.target))
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const token =
        Option.isSome(credential) && credential.value._tag === "BearerConnectionCredential"
          ? credential.value.token
          : "";
      saved.push({ environmentId, origin, token });
    }
  }
  return saved;
});

const linkOnce = Effect.fn("codrHub.linkTailnetMesh.once")(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  let result: HubLinkTailnetResult | undefined;
  for (const id of yield* connectedIntroducers()) {
    const answer = yield* registry
      .run(id, request(WS_METHODS.hubLinkTailnet, {}))
      .pipe(Effect.option);
    if (Option.isSome(answer)) {
      result = answer.value;
      break;
    }
  }
  const saved = yield* savedRoutes();
  if (result === undefined) {
    // No connected machine runs Codr-Hub. Join Codr-Hub on a known tailnet machine; the
    // next pass links the rest through it.
    // ponytail: retries failed hosts every pass; remember misses if this gets noisy.
    for (const origin of codrHubProbeOrigins(saved.map((route) => route.origin))) {
      const joined = yield* joinTailnetHost(origin).pipe(Effect.option);
      if (Option.isSome(joined)) return;
    }
    return;
  }
  for (const link of result.links) {
    if (catalogDecision(saved, link) === "skip") continue;
    const connectionId = bearerConnectionId(link.environmentId, link.httpBaseUrl);
    yield* registry
      .register(
        new BearerConnectionRegistration({
          target: new BearerConnectionTarget({
            environmentId: link.environmentId,
            label: link.label,
            connectionId,
          }),
          profile: new BearerConnectionProfile({
            connectionId,
            environmentId: link.environmentId,
            label: link.label,
            httpBaseUrl: link.httpBaseUrl,
            wsBaseUrl: link.wsBaseUrl,
          }),
          credential: new BearerConnectionCredential({ token: link.accessToken }),
        }),
      )
      .pipe(Effect.catch(() => Effect.logWarning("Could not save a Tailscale Codr-Hub machine.")));
  }
});

const linkTailnetMesh = Effect.fn("codrHub.linkTailnetMesh")(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const introducerId = yield* SubscriptionRef.changes(registry.entries).pipe(
    Stream.switchMap((entries) => {
      const ids = [...entries.keys()];
      if (ids.length === 0) return Stream.never;
      return Stream.mergeAll(
        ids.map((id) =>
          registry.stateChanges(id).pipe(
            Stream.map(() => undefined),
            Stream.catch(() => Stream.never),
          ),
        ),
        { concurrency: "unbounded" },
      );
    }),
    Stream.mapEffect(() => connectedIntroducers()),
    Stream.filter((ids) => ids.length > 0),
    Stream.take(1),
    Stream.runHead,
  );
  if (Option.isNone(introducerId)) return;
  // A machine that starts later still gets linked. A repeat with the same
  // token does not register again.
  yield* linkOnce().pipe(
    Effect.catchCause(() => Effect.logWarning("Could not link Tailscale Codr-Hub machines.")),
    Effect.repeat(Schedule.spaced(Duration.seconds(60))),
  );
});

const TailnetJoinResponse = Schema.Struct({ accessToken: Schema.NonEmptyString });

const tailnetJoinFailed = (host: string) =>
  new ConnectionBlockedError({
    reason: "configuration",
    detail: `Couldn't join ${host} over Tailscale. Check the phone is on your tailnet and the machine serves Codr-Hub with Tailscale Serve, or enter a pairing code.`,
  });

/**
 * Saves the machine at a tailnet address without a pairing code. The server admits only
 * tailnet sockets. Once saved, the mesh layer saves the account's other machines.
 */
export const joinTailnetHost = Effect.fn("codrHub.linkTailnetMesh.joinHost")(function* (
  host: string,
) {
  const trimmed = host.trim();
  const failed = () => tailnetJoinFailed(trimmed);
  const httpBaseUrl = yield* Effect.try({
    try: () =>
      normalizeHttpBaseUrl(
        new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).origin,
      ),
    catch: failed,
  });
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.mapError(failed),
  );
  const client = yield* HttpClient.HttpClient;
  const joined = yield* client
    .post(environmentEndpointUrl(httpBaseUrl, "/.well-known/t3/tailnet/join"))
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(TailnetJoinResponse)),
      Effect.timeout(Duration.seconds(10)),
      Effect.mapError(failed),
    );
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const connectionId = bearerConnectionId(descriptor.environmentId, httpBaseUrl);
  yield* registry.register(
    new BearerConnectionRegistration({
      target: new BearerConnectionTarget({
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        connectionId,
      }),
      profile: new BearerConnectionProfile({
        connectionId,
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl,
        wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
      }),
      credential: new BearerConnectionCredential({ token: joined.accessToken }),
    }),
  );
  yield* registry
    .setEnabled(descriptor.environmentId, true)
    .pipe(Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.void }));
  return descriptor.environmentId;
}, Effect.provide(FetchHttpClient.layer));

export const linkTailnetMeshLayer = Layer.effectDiscard(
  linkTailnetMesh().pipe(
    Effect.catchCause(() => Effect.logWarning("Could not link Tailscale Codr-Hub machines.")),
    Effect.forkScoped,
  ),
);

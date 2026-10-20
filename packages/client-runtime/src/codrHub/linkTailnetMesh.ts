import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionCatalogEntry,
} from "../connection/catalog.ts";
import * as ConnectionCredentialStore from "../connection/credentialStore.ts";
import { BearerConnectionTarget } from "../connection/model.ts";
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

function introducerRank(entry: ConnectionCatalogEntry): number {
  const routes = connectionRoutes(entry);
  if (routes.some((route) => route.target._tag === "PrimaryConnectionTarget")) return 0;
  if (routes.some((route) => connectionRouteKind(route) === "loopback")) return 1;
  return 2;
}

const currentIntroducer = Effect.fn("codrHub.linkTailnetMesh.introducer")(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const entries = yield* SubscriptionRef.get(registry.entries);
  let best: { readonly id: EnvironmentId; readonly rank: number } | undefined;
  for (const [id, entry] of entries) {
    if (!entry.enabled) continue;
    const state = yield* registry.state(id).pipe(Effect.option);
    if (Option.isNone(state) || state.value.phase !== "connected") continue;
    const rank = introducerRank(entry);
    if (best === undefined || rank < best.rank) best = { id, rank };
  }
  return best?.id;
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

export const linkTailnetMesh = Effect.fn("codrHub.linkTailnetMesh")(function* () {
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
    Stream.mapEffect(() => currentIntroducer()),
    Stream.filter((id): id is EnvironmentId => id !== undefined),
    Stream.take(1),
    Stream.runHead,
  );
  if (Option.isNone(introducerId)) return;
  const result = yield* registry.run(introducerId.value, request(WS_METHODS.hubLinkTailnet, {}));
  const saved = yield* savedRoutes();
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

export const linkTailnetMeshLayer = Layer.effectDiscard(
  linkTailnetMesh().pipe(
    Effect.catchCause(() => Effect.logWarning("Could not link Tailscale Codr-Hub machines.")),
    Effect.forkScoped,
  ),
);

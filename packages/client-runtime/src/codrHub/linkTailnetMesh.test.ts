import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import { describe, expect, it } from "@effect/vitest";

import type { BearerConnectionRegistration } from "../connection/catalog.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { catalogDecision, joinTailnetHost } from "./linkTailnetMesh.ts";

const link = {
  environmentId: "env-1",
  httpBaseUrl: "https://peer.tail.ts.net:5733",
  accessToken: "token-a",
};

describe("catalogDecision", () => {
  it("skips a route that already has the same environment, origin, and token", () => {
    expect(
      catalogDecision(
        [
          {
            environmentId: "env-1",
            origin: "https://peer.tail.ts.net:5733",
            token: "token-a",
          },
        ],
        link,
      ),
    ).toBe("skip");
  });

  it("saves when the origin differs", () => {
    expect(
      catalogDecision(
        [
          {
            environmentId: "env-1",
            origin: "https://peer.tail.ts.net",
            token: "token-a",
          },
        ],
        link,
      ),
    ).toBe("save");
  });
});

describe("joinTailnetHost", () => {
  it.effect("saves the tailnet machine with the token its join endpoint mints", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const registered: BearerConnectionRegistration[] = [];
      const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        requests.push(
          `${init?.method ?? (input instanceof Request ? input.method : "GET")} ${url}`,
        );
        return url.endsWith("/tailnet/join")
          ? Response.json({ accessToken: "minted" })
          : Response.json({
              environmentId: "env-pc",
              label: "PC",
              platform: { os: "windows", arch: "x64" },
              serverVersion: "0.0.32",
              capabilities: { repositoryIdentity: true },
            });
      }) as typeof globalThis.fetch;
      const registry = EnvironmentRegistry.EnvironmentRegistry.of({
        register: (registration: BearerConnectionRegistration) =>
          Effect.sync(() => registered.push(registration)).pipe(Effect.as(true)),
        setEnabled: () => Effect.void,
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);

      const id = yield* joinTailnetHost(" pc.tail1.ts.net ").pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );

      expect(id).toBe("env-pc");
      expect(requests).toEqual([
        "GET https://pc.tail1.ts.net/.well-known/t3/environment",
        "POST https://pc.tail1.ts.net/.well-known/t3/tailnet/join",
      ]);
      expect(registered[0]?.credential.token).toBe("minted");
      expect(registered[0]?.profile.wsBaseUrl).toBe("wss://pc.tail1.ts.net/");
    }),
  );
});

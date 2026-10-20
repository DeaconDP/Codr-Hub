import { describe, expect, it } from "vite-plus/test";

import { catalogDecision } from "./linkTailnetMesh.ts";

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

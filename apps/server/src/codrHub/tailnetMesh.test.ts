import { describe, expect, it } from "@effect/vitest";

import {
  createSessionCache,
  discoverOrigins,
  parseMeshManifest,
  rosterFromStatus,
  selfDnsName,
  selfPeer,
  tailnetAdmit,
} from "./tailnetMesh.ts";

const SELF = "n1111111111111111";
const SAME = "n2222222222222222";
const OTHER = "n3333333333333333";
const OFFLINE = "n4444444444444444";
const FOREIGN = "n5555555555555555";

const running = {
  BackendState: "Running",
  MagicDNSSuffix: "tail.ts.net",
  Self: {
    ID: SELF,
    DNSName: "self.tail.ts.net.",
    UserID: 7,
    Online: true,
  },
  Peer: {
    same: {
      ID: SAME,
      DNSName: "peer.tail.ts.net.",
      UserID: 7,
      Online: true,
    },
    otherUser: {
      ID: OTHER,
      DNSName: "other.tail.ts.net.",
      UserID: 8,
      Online: true,
    },
    offline: {
      ID: OFFLINE,
      DNSName: "off.tail.ts.net.",
      UserID: 7,
      Online: false,
    },
    otherSuffix: {
      ID: FOREIGN,
      DNSName: "peer.other.ts.net.",
      UserID: 7,
      Online: true,
    },
  },
};

describe("tailnet mesh", () => {
  it("treats logged-out or non-running status as an empty roster", () => {
    expect(rosterFromStatus({ BackendState: "NeedsLogin" })).toEqual([]);
    expect(rosterFromStatus({ BackendState: "Stopped", Self: running.Self })).toEqual([]);
    expect(rosterFromStatus("not-json")).toEqual([]);
    expect(rosterFromStatus(null)).toEqual([]);
  });

  it("keeps an online same-user peer and drops self, other users, and other suffixes", () => {
    const roster = rosterFromStatus(running);
    expect(roster.map((peer) => peer.nodeId)).toEqual([SAME]);
    expect(roster[0]?.dnsName).toBe("peer.tail.ts.net");
    expect(selfDnsName(running)).toBe("self.tail.ts.net");
  });

  it("admits a loopback or tailnet socket only while Tailscale is running", () => {
    expect(tailnetAdmit({ running: true, remoteAddress: "127.0.0.1" })).toBe(true);
    expect(tailnetAdmit({ running: true, remoteAddress: "::ffff:127.0.0.1" })).toBe(true);
    expect(tailnetAdmit({ running: true, remoteAddress: "100.64.0.1" })).toBe(true);
    expect(tailnetAdmit({ running: true, remoteAddress: "203.0.113.5" })).toBe(false);
    expect(tailnetAdmit({ running: false, remoteAddress: "127.0.0.1" })).toBe(false);
    expect(tailnetAdmit({ running: true, remoteAddress: null })).toBe(false);
    expect(selfPeer(running)?.nodeId).toBe(SELF);
    expect(selfPeer({ BackendState: "NeedsLogin" })).toBeNull();
  });

  it("tries the peer root, the dev share port, and manifest origins on that name", () => {
    expect(
      discoverOrigins("peer.tail.ts.net", [
        { origins: ["https://peer.tail.ts.net:8443", "https://evil.example"] },
      ]),
    ).toEqual([
      "https://peer.tail.ts.net",
      "https://peer.tail.ts.net:5733",
      "https://peer.tail.ts.net:8443",
    ]);
  });

  it("keeps a MagicDNS https origin and drops a different host", () => {
    expect(
      parseMeshManifest(
        {
          origins: [
            "https://evil.example",
            "http://peer.tail.ts.net:5733",
            "https://peer.tail.ts.net.evil",
            "https://peer.tail.ts.net:5733",
            "https://peer.tail.ts.net",
          ],
        },
        "peer.tail.ts.net",
      ),
    ).toEqual(["https://peer.tail.ts.net:5733", "https://peer.tail.ts.net"]);
  });

  it("reads the suffix from CurrentTailnet when the top-level field is absent", () => {
    const { MagicDNSSuffix: _omitted, ...withoutTopLevel } = running;
    expect(
      rosterFromStatus({
        ...withoutTopLevel,
        CurrentTailnet: { MagicDNSSuffix: "tail.ts.net." },
      }).map((peer) => peer.dnsName),
    ).toEqual(["peer.tail.ts.net"]);
  });

  it("returns the first minted token for a node", () => {
    const cache = createSessionCache();
    expect(cache.remember(SAME, "token-a")).toBe("token-a");
    expect(cache.remember(SAME, "token-b")).toBe("token-a");
  });
});

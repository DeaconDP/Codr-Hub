import { describe, expect, it } from "@effect/vitest";

import {
  confirmEcho,
  createEchoLedger,
  createSessionCache,
  parseMeshManifest,
  planTailnetServe,
  replyHostPeer,
  rosterFromStatus,
  selfDnsName,
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

  it("echoes one nonce once and refuses a mismatched body", () => {
    const peer = rosterFromStatus(running)[0]!;
    const ledger = createEchoLedger();
    const replyHost = selfDnsName(running);
    expect(replyHost).toBe("self.tail.ts.net");
    const nonce = ledger.issue({
      peerDns: peer.dnsName,
      replyHost: replyHost!,
      nowMs: 1_000,
    });
    expect(ledger.take(nonce, "evil.tail.ts.net", 2_000)).toBeNull();
    expect(ledger.take(nonce, "self.tail.ts.net", 2_000)).toBe(nonce);
    expect(ledger.take(nonce, "self.tail.ts.net", 2_000)).toBeNull();
    expect(ledger.take("different-nonce", "self.tail.ts.net", 2_000)).toBeNull();
    expect(confirmEcho(peer, nonce, "different-nonce")).toBeNull();
    expect(confirmEcho(peer, nonce, nonce)).toMatchObject({
      _tag: "TailnetPrincipal",
      nodeId: SAME,
    });
  });

  it("refuses a reply host that is not a same-user peer before an echo exists", () => {
    const roster = rosterFromStatus(running);
    expect(replyHostPeer(roster, "https://other.tail.ts.net")).toBeNull();
    expect(replyHostPeer(roster, "https://stranger.example")).toBeNull();
    expect(replyHostPeer(roster, "http://peer.tail.ts.net")).toBeNull();
    expect(replyHostPeer(roster, "https://peer.tail.ts.net:5733")).toEqual({
      peer: roster[0],
      echoUrl: "https://peer.tail.ts.net/.well-known/t3/tailnet/echo",
    });
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

  it("plans a tailnet path on 443 and does not enable Funnel", () => {
    const plan = planTailnetServe(13773);
    expect(plan).toEqual([
      "serve",
      "--bg",
      "--https=443",
      "--set-path=/.well-known/t3",
      "http://127.0.0.1:13773/.well-known/t3",
    ]);
    expect(plan.some((arg) => arg.toLowerCase().includes("funnel"))).toBe(false);
  });

  it("returns the first minted token for a node", () => {
    const cache = createSessionCache();
    expect(cache.remember(SAME, "token-a")).toBe("token-a");
    expect(cache.remember(SAME, "token-b")).toBe("token-a");
  });
});

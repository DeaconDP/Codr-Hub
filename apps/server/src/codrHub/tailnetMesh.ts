import {
  AuthStandardClientScopes,
  ExecutionEnvironmentDescriptor,
  type EnvironmentId,
} from "@t3tools/contracts";
import { deriveWsBaseUrl, normalizeHttpBaseUrl } from "@t3tools/shared/advertisedEndpoint";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

const STATUS_TIMEOUT = Duration.millis(1_500);
const SERVE_TIMEOUT = Duration.seconds(10);
const HTTP_TIMEOUT = Duration.millis(2_500);
const NONCE_TTL_MS = 15_000;
const MESH_PREFIX = "/.well-known/t3";

declare const TailnetNodeIdBrand: unique symbol;
declare const MagicDnsNameBrand: unique symbol;
declare const TailnetUserIdBrand: unique symbol;
declare const TailnetAccessTokenBrand: unique symbol;

/** Stable Tailscale node id (`n…`). Not a DNS name or a user id. */
export type TailnetNodeId = string & { readonly [TailnetNodeIdBrand]: "TailnetNodeId" };
/** MagicDNS name, lowercased, without a trailing dot. */
export type MagicDnsName = string & { readonly [MagicDnsNameBrand]: "MagicDnsName" };
/** Tailscale user id. Not a node id. */
export type TailnetUserId = number & { readonly [TailnetUserIdBrand]: "TailnetUserId" };
/** Bearer token minted for one introducer. Not a node id. */
export type TailnetAccessToken = string & {
  readonly [TailnetAccessTokenBrand]: "TailnetAccessToken";
};

/** An online same-user node. It has not proved it can see this server. */
export interface TailnetPeer {
  readonly nodeId: TailnetNodeId;
  readonly dnsName: MagicDnsName;
  readonly userId: TailnetUserId;
}

/** A peer whose echo matched the nonce this server issued. Only this can mint. */
export interface TailnetPrincipal extends TailnetPeer {
  readonly _tag: "TailnetPrincipal";
}

export interface MeshLink {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly accessToken: string;
  readonly scopes: typeof AuthStandardClientScopes;
}

const decodeDescriptor = Schema.decodeUnknownEffect(ExecutionEnvironmentDescriptor);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeId(value: unknown): TailnetNodeId | null {
  if (typeof value !== "string" || !/^n[A-Za-z0-9]+$/.test(value)) return null;
  return value as TailnetNodeId;
}

function userId(value: unknown): TailnetUserId | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return value as TailnetUserId;
}

function magicDnsName(value: unknown): MagicDnsName | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\.$/u, "").toLowerCase();
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(normalized)) return null;
  return normalized as MagicDnsName;
}

function accessToken(value: string): TailnetAccessToken | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed as TailnetAccessToken;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function magicSuffix(field: unknown, selfDns: MagicDnsName): string | null {
  if (typeof field === "string") {
    const normalized = field.trim().replace(/\.$/u, "").toLowerCase();
    if (normalized.length > 0) return normalized;
  }
  const dot = selfDns.indexOf(".");
  return dot === -1 ? null : selfDns.slice(dot + 1);
}

function onSuffix(dnsName: MagicDnsName, suffix: string): boolean {
  return dnsName === suffix || dnsName.endsWith(`.${suffix}`);
}

export function selfDnsName(value: unknown): MagicDnsName | null {
  if (!isRecord(value) || value.BackendState !== "Running" || !isRecord(value.Self)) return null;
  return magicDnsName(value.Self.DNSName);
}

/** Logged-out, stopped, or unreadable status is an empty roster. Self is omitted. */
export function rosterFromStatus(value: unknown): readonly TailnetPeer[] {
  if (!isRecord(value) || value.BackendState !== "Running" || !isRecord(value.Self)) return [];
  const selfDns = magicDnsName(value.Self.DNSName);
  const selfUser = userId(value.Self.UserID);
  const selfNode = nodeId(value.Self.ID);
  if (selfDns === null || selfUser === null || selfNode === null) return [];
  const suffix = magicSuffix(value.MagicDNSSuffix, selfDns);
  if (suffix === null) return [];
  if (!isRecord(value.Peer)) return [];
  const roster: TailnetPeer[] = [];
  for (const peer of Object.values(value.Peer)) {
    if (!isRecord(peer) || peer.Online !== true) continue;
    const dnsName = magicDnsName(peer.DNSName);
    const peerUser = userId(peer.UserID);
    const id = nodeId(peer.ID);
    if (dnsName === null || peerUser === null || id === null) continue;
    if (id === selfNode || dnsName === selfDns) continue;
    if (peerUser !== selfUser) continue;
    if (!onSuffix(dnsName, suffix)) continue;
    roster.push({ nodeId: id, dnsName, userId: peerUser });
  }
  return roster;
}

/** HTTPS origins whose host is this peer's MagicDNS name. `url.origin` keeps a non-443 port. */
export function parseMeshManifest(value: unknown, peerDns: string): readonly string[] {
  const expected = magicDnsName(peerDns);
  if (expected === null || !isRecord(value) || !Array.isArray(value.origins)) return [];
  const kept: string[] = [];
  for (const origin of value.origins) {
    if (typeof origin !== "string") continue;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") continue;
    if (url.hostname.toLowerCase() !== expected) continue;
    if (!kept.includes(url.origin)) kept.push(url.origin);
  }
  return kept;
}

function splitHostPort(value: string): { readonly host: string; readonly port: number } | null {
  const colon = value.lastIndexOf(":");
  if (colon <= 0) return null;
  const host = value
    .slice(0, colon)
    .replace(/^\[|\]$/gu, "")
    .toLowerCase();
  const port = Number(value.slice(colon + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const dns = magicDnsName(host);
  if (dns === null) return null;
  return { host: dns, port };
}

/** HTTPS origins from `tailscale serve status --json` for this machine's MagicDNS name. */
export function serveOrigins(value: unknown, selfDns: MagicDnsName): readonly string[] {
  if (!isRecord(value) || !isRecord(value.Web)) return [];
  const tcp = isRecord(value.TCP) ? value.TCP : {};
  const origins: string[] = [];
  for (const key of Object.keys(value.Web)) {
    const parsed = splitHostPort(key);
    if (parsed === null || parsed.host !== selfDns) continue;
    const tcpEntry = tcp[String(parsed.port)];
    if (!isRecord(tcpEntry) || tcpEntry.HTTPS !== true) continue;
    const origin =
      parsed.port === 443 ? `https://${parsed.host}` : `https://${parsed.host}:${parsed.port}`;
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/**
 * A reply host that is not in the roster has no echo URL, so the caller never
 * asks for an echo body.
 */
export function replyHostPeer(
  roster: readonly TailnetPeer[],
  replyOrigin: string,
): { readonly peer: TailnetPeer; readonly echoUrl: string } | null {
  let url: URL;
  try {
    url = new URL(replyOrigin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  const host = magicDnsName(url.hostname);
  if (host === null) return null;
  const peer = roster.find((candidate) => candidate.dnsName === host);
  if (peer === undefined) return null;
  return { peer, echoUrl: `https://${host}${MESH_PREFIX}/tailnet/echo` };
}

export function confirmEcho(
  peer: TailnetPeer,
  nonce: string,
  echoBody: string,
): TailnetPrincipal | null {
  if (nonce.length === 0 || echoBody !== nonce) return null;
  return {
    _tag: "TailnetPrincipal",
    nodeId: peer.nodeId,
    dnsName: peer.dnsName,
    userId: peer.userId,
  };
}

interface PendingNonce {
  readonly nonce: string;
  readonly peerDns: MagicDnsName;
  readonly replyHost: MagicDnsName;
  readonly expiresAtMs: number;
}

export function createEchoLedger() {
  const pending = new Map<string, PendingNonce>();
  return {
    issue(input: {
      readonly peerDns: MagicDnsName;
      readonly replyHost: MagicDnsName;
      readonly nowMs: number;
      readonly nonce?: string;
    }): string {
      const nonce = input.nonce ?? NodeCrypto.randomBytes(16).toString("hex");
      for (const [key, value] of pending) {
        if (value.peerDns === input.peerDns) pending.delete(key);
      }
      pending.set(nonce, {
        nonce,
        peerDns: input.peerDns,
        replyHost: input.replyHost,
        expiresAtMs: input.nowMs + NONCE_TTL_MS,
      });
      return nonce;
    },
    take(nonce: string, replyHost: string, nowMs: number): string | null {
      const found = pending.get(nonce);
      if (found === undefined) return null;
      if (nowMs >= found.expiresAtMs) {
        pending.delete(nonce);
        return null;
      }
      if (found.replyHost !== replyHost) return null;
      pending.delete(nonce);
      return found.nonce;
    },
  };
}

export function createSessionCache() {
  const tokens = new Map<string, TailnetAccessToken>();
  return {
    get(nodeId: string): TailnetAccessToken | undefined {
      return tokens.get(nodeId);
    },
    remember(nodeId: string, token: string): string {
      const cached = tokens.get(nodeId);
      if (cached !== undefined) return cached;
      const branded = accessToken(token);
      if (branded === null) return token;
      tokens.set(nodeId, branded);
      return branded;
    },
  };
}

/**
 * Tailscale strips the mount before proxying, so the local target repeats the
 * prefix. Funnel is absent: the path stays on the tailnet.
 */
export function planTailnetServe(localPort: number): readonly string[] {
  return [
    "serve",
    "--bg",
    "--https=443",
    `--set-path=${MESH_PREFIX}`,
    `http://127.0.0.1:${localPort}${MESH_PREFIX}`,
  ];
}

const echoes = createEchoLedger();
const sessions = createSessionCache();

const collectText = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const tailscaleExecutable = (platform: NodeJS.Platform) =>
  platform === "win32" ? "tailscale.exe" : "tailscale";

/** Stdout, or null when the CLI is missing, logged out, timed out, or exits nonzero. Stderr is drained and dropped. */
const tailscaleStdout = (args: readonly string[], timeout: Duration.Duration) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = yield* HostProcessPlatform;
    const executable = tailscaleExecutable(platform);
    return yield* Effect.gen(function* () {
      const child = yield* spawner
        .spawn(ChildProcess.make(executable, args))
        .pipe(Effect.catchDefect(() => Effect.fail("absent")));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectText(child.stdout),
          collectText(child.stderr),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );
      // Drain stderr so the child can exit, and drop it. It can contain auth keys.
      void stderr;
      if (exitCode !== 0) return null;
      return stdout;
    }).pipe(
      Effect.scoped,
      Effect.timeout(timeout),
      Effect.mapError(() => "absent" as const),
      Effect.orElseSucceed(() => null),
    );
  }).pipe(Effect.catchDefect(() => Effect.succeed(null)));

const noRedirect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }));

const readHttpText = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* noRedirect(client.execute(request)).pipe(
      Effect.timeoutOption(HTTP_TIMEOUT),
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(response) || response.value.status !== 200) return null;
    return yield* response.value.text.pipe(Effect.orElseSucceed(() => null));
  });

const mintAccessToken = Effect.fn("codrHub.tailnetMesh.mint")(function* (
  principal: TailnetPrincipal,
) {
  const cached = sessions.get(principal.nodeId);
  if (cached !== undefined) return cached;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const pairing = yield* auth.createPairingLink({
    scopes: AuthStandardClientScopes,
    subject: `tailnet-node:${principal.nodeId}`,
    label: "Tailnet mesh",
  });
  const access = yield* auth.exchangeBootstrapCredentialForAccessToken(
    pairing.credential,
    [...AuthStandardClientScopes],
    { deviceType: "bot", label: "Tailnet mesh" },
  );
  return sessions.remember(principal.nodeId, access.access_token);
});

function readNonce(value: unknown): string | null {
  if (!isRecord(value) || typeof value.nonce !== "string" || value.nonce.length === 0) return null;
  return value.nonce;
}

function readWitness(
  value: unknown,
): { readonly nonce: string; readonly replyOrigin: string } | null {
  const nonce = readNonce(value);
  if (nonce === null || !isRecord(value) || typeof value.replyOrigin !== "string") return null;
  return { nonce, replyOrigin: value.replyOrigin };
}

function hostnameOf(hostHeader: string | undefined): string | null {
  if (hostHeader === undefined || hostHeader.length === 0) return null;
  try {
    return new URL(`https://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export const meshManifestHandler = Effect.gen(function* () {
  const statusText = yield* tailscaleStdout(["status", "--json"], STATUS_TIMEOUT);
  const status = statusText === null ? null : parseJson(statusText);
  const selfDns = selfDnsName(status);
  if (selfDns === null) return HttpServerResponse.jsonUnsafe({ origins: [] });
  const serveText = yield* tailscaleStdout(["serve", "status", "--json"], STATUS_TIMEOUT);
  const origins = serveText === null ? [] : serveOrigins(parseJson(serveText), selfDns);
  return HttpServerResponse.jsonUnsafe({ origins });
}).pipe(Effect.orElseSucceed(() => HttpServerResponse.jsonUnsafe({ origins: [] })));

export const echoHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  // Serve terminates TLS on the tailnet and connects here as 127.0.0.1, so the
  // socket is not the caller. Host is the MagicDNS name the peer requested.
  const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
  const nonce = readNonce(body);
  const host = hostnameOf(request.headers.host);
  const nowMs = yield* Clock.currentTimeMillis;
  if (nonce === null || host === null) return HttpServerResponse.empty({ status: 404 });
  const echoed = echoes.take(nonce, host, nowMs);
  if (echoed === null) return HttpServerResponse.empty({ status: 404 });
  return HttpServerResponse.text(echoed);
}).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 404 })));

export const witnessHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
  const parsed = readWitness(body);
  if (parsed === null) return HttpServerResponse.empty({ status: 400 });
  const statusText = yield* tailscaleStdout(["status", "--json"], STATUS_TIMEOUT);
  const roster = statusText === null ? [] : rosterFromStatus(parseJson(statusText));
  const admitted = replyHostPeer(roster, parsed.replyOrigin);
  if (admitted === null) return HttpServerResponse.empty({ status: 403 });
  const echoText = yield* readHttpText(
    HttpClientRequest.post(admitted.echoUrl).pipe(
      HttpClientRequest.bodyJsonUnsafe({ nonce: parsed.nonce }),
    ),
  );
  const principal =
    echoText === null ? null : confirmEcho(admitted.peer, parsed.nonce, echoText.trim());
  if (principal === null) return HttpServerResponse.empty({ status: 403 });
  const token = yield* mintAccessToken(principal).pipe(Effect.option);
  if (Option.isNone(token)) return HttpServerResponse.empty({ status: 403 });
  return HttpServerResponse.jsonUnsafe({ accessToken: token.value });
}).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500 })));

const linkOrigin = Effect.fn("codrHub.tailnetMesh.linkOrigin")(function* (
  peer: TailnetPeer,
  origin: string,
  selfDns: MagicDnsName,
) {
  const descriptorText = yield* readHttpText(
    HttpClientRequest.get(new URL("/.well-known/t3/environment", origin).toString()),
  );
  if (descriptorText === null) return null;
  const decoded = yield* decodeDescriptor(parseJson(descriptorText)).pipe(Effect.option);
  if (Option.isNone(decoded)) return null;
  const nowMs = yield* Clock.currentTimeMillis;
  const nonce = echoes.issue({
    peerDns: peer.dnsName,
    replyHost: selfDns,
    nowMs,
  });
  const replyOrigin = `https://${selfDns}/`;
  const witnessText = yield* readHttpText(
    HttpClientRequest.post(new URL(`${MESH_PREFIX}/tailnet/witness`, origin).toString()).pipe(
      HttpClientRequest.bodyJsonUnsafe({ nonce, replyOrigin }),
    ),
  );
  if (witnessText === null) return null;
  const witness = parseJson(witnessText);
  if (!isRecord(witness) || typeof witness.accessToken !== "string") return null;
  const token = accessToken(witness.accessToken);
  if (token === null) return null;
  const httpBaseUrl = normalizeHttpBaseUrl(origin);
  return {
    environmentId: decoded.value.environmentId,
    label: decoded.value.label,
    httpBaseUrl,
    wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
    accessToken: token,
    scopes: AuthStandardClientScopes,
  } satisfies MeshLink;
});

const linksForPeer = Effect.fn("codrHub.tailnetMesh.linksForPeer")(function* (
  peer: TailnetPeer,
  selfDns: MagicDnsName,
) {
  const manifestText = yield* readHttpText(
    HttpClientRequest.get(`https://${peer.dnsName}${MESH_PREFIX}/codr-hub-mesh`),
  );
  if (manifestText === null) return [];
  const origins = parseMeshManifest(parseJson(manifestText), peer.dnsName);
  const links: MeshLink[] = [];
  for (const origin of origins) {
    const link = yield* linkOrigin(peer, origin, selfDns).pipe(Effect.orElseSucceed(() => null));
    if (link !== null) links.push(link);
  }
  return links;
});

export const linkTailnet = Effect.fn("codrHub.tailnetMesh.link")(function* () {
  const statusText = yield* tailscaleStdout(["status", "--json"], STATUS_TIMEOUT);
  if (statusText === null) return { links: [] satisfies MeshLink[] };
  const status = parseJson(statusText);
  const selfDns = selfDnsName(status);
  if (selfDns === null) return { links: [] satisfies MeshLink[] };
  const groups = yield* Effect.forEach(
    rosterFromStatus(status),
    (peer) => linksForPeer(peer, selfDns),
    { concurrency: 4 },
  );
  return { links: groups.flat() };
});

export const ensureTailnetMeshPath = Effect.fn("codrHub.tailnetMesh.ensurePath")(function* (
  localPort: number,
) {
  const statusText = yield* tailscaleStdout(["status", "--json"], STATUS_TIMEOUT);
  if (statusText === null || selfDnsName(parseJson(statusText)) === null) return;
  const applied = yield* tailscaleStdout(planTailnetServe(localPort), SERVE_TIMEOUT);
  if (applied === null) {
    yield* Effect.logWarning("Tailnet mesh path on port 443 was not applied.");
  }
});

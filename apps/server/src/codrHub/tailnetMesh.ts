import {
  AuthStandardClientScopes,
  ExecutionEnvironmentDescriptor,
  type EnvironmentId,
} from "@t3tools/contracts";
import { deriveWsBaseUrl, normalizeHttpBaseUrl } from "@t3tools/shared/advertisedEndpoint";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isTailscaleIpv4Address } from "@t3tools/tailscale";
import * as DateTime from "effect/DateTime";
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
import * as Cookies from "effect/unstable/http/Cookies";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";

const STATUS_TIMEOUT = Duration.millis(1_500);
const HTTP_TIMEOUT = Duration.millis(2_500);
const MESH_PREFIX = "/.well-known/t3";
const JOIN_PATH = `${MESH_PREFIX}/tailnet/join`;
/** Dev share publishes the web port. The manifest adds any other HTTPS port. */
const DEV_SHARE_PORT = 5733;
const BROWSER_JOIN_HEADER = "x-codr-hub-tailnet";

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

/** An online node on this Tailscale account. */
export interface TailnetPeer {
  readonly nodeId: TailnetNodeId;
  readonly dnsName: MagicDnsName;
  readonly userId: TailnetUserId;
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

function suffixField(field: unknown): string | null {
  if (typeof field !== "string") return null;
  const normalized = field.trim().replace(/\.$/u, "").toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function magicSuffix(status: Record<string, unknown>, selfDns: MagicDnsName): string | null {
  const current = isRecord(status.CurrentTailnet)
    ? status.CurrentTailnet.MagicDNSSuffix
    : undefined;
  return (
    suffixField(status.MagicDNSSuffix) ??
    suffixField(current) ??
    (selfDns.includes(".") ? selfDns.slice(selfDns.indexOf(".") + 1) : null)
  );
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
  const suffix = magicSuffix(value, selfDns);
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

function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  return trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1";
}

/**
 * Tailscale Serve delivers the tailnet to this process as loopback. A direct
 * tailnet socket is 100.64/10. Anything else, including a logged-out machine,
 * is refused. Funnel uses the same loopback socket, so leave Funnel off.
 */
export function tailnetAdmit(input: {
  readonly running: boolean;
  readonly remoteAddress: string | null;
}): boolean {
  if (!input.running || input.remoteAddress === null || input.remoteAddress.length === 0) {
    return false;
  }
  const address = normalizeAddress(input.remoteAddress);
  return isLoopbackAddress(address) || isTailscaleIpv4Address(address);
}

/** This machine, when Tailscale is logged in and running. */
export function selfPeer(value: unknown): TailnetPeer | null {
  if (!isRecord(value) || value.BackendState !== "Running" || !isRecord(value.Self)) return null;
  const dnsName = magicDnsName(value.Self.DNSName);
  const id = nodeId(value.Self.ID);
  const uid = userId(value.Self.UserID);
  if (dnsName === null || id === null || uid === null) return null;
  return { nodeId: id, dnsName, userId: uid };
}

/**
 * Always try the peer's HTTPS root and the dev share port. A manifest can add
 * other HTTPS origins on that same MagicDNS name.
 */
export function discoverOrigins(peerDns: string, manifests: readonly unknown[]): readonly string[] {
  const dns = magicDnsName(peerDns);
  if (dns === null) return [];
  const kept: string[] = [];
  const push = (origin: string) => {
    if (!kept.includes(origin)) kept.push(origin);
  };
  push(`https://${dns}`);
  push(`https://${dns}:${DEV_SHARE_PORT}`);
  for (const manifest of manifests) {
    for (const origin of parseMeshManifest(manifest, dns)) push(origin);
  }
  return kept;
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

const mintAccessToken = Effect.fn("codrHub.tailnetMesh.mint")(function* (peer: TailnetPeer) {
  const cached = sessions.get(peer.nodeId);
  if (cached !== undefined) return cached;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const pairing = yield* auth.createPairingLink({
    scopes: AuthStandardClientScopes,
    subject: `tailnet-node:${peer.nodeId}`,
    label: "Tailscale",
  });
  const access = yield* auth.exchangeBootstrapCredentialForAccessToken(
    pairing.credential,
    [...AuthStandardClientScopes],
    { deviceType: "bot", label: "Tailscale" },
  );
  return sessions.remember(peer.nodeId, access.access_token);
});

function requestAddress(request: HttpServerRequest.HttpServerRequest): string | null {
  return Option.getOrNull(request.remoteAddress);
}

function wantsBrowserSession(request: HttpServerRequest.HttpServerRequest): boolean {
  return request.headers[BROWSER_JOIN_HEADER] === "browser";
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

const issueBrowserCookie = Effect.fn("codrHub.tailnetMesh.browserCookie")(function* (
  self: TailnetPeer,
  request: HttpServerRequest.HttpServerRequest,
  token: string,
) {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const sessions = yield* SessionStore.SessionStore;
  const pairing = yield* auth.createPairingLink({
    scopes: AuthStandardClientScopes,
    subject: `tailnet-node:${self.nodeId}`,
    label: "Tailscale",
  });
  const browser = yield* auth.createBrowserSession(
    pairing.credential,
    deriveAuthClientMetadata({ request }),
  );
  const cookieName = browser.cookieName ?? sessions.cookieName;
  const cookies = yield* Effect.fromResult(
    Cookies.set(Cookies.empty, cookieName, browser.sessionToken, {
      expires: DateTime.toDate(browser.response.expiresAt),
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    }),
  );
  return HttpServerResponse.mergeCookies(
    HttpServerResponse.jsonUnsafe({ accessToken: token }),
    cookies,
  );
});

export const joinHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const statusText = yield* tailscaleStdout(["status", "--json"], STATUS_TIMEOUT);
  const status = statusText === null ? null : parseJson(statusText);
  const self = selfPeer(status);
  if (!tailnetAdmit({ running: self !== null, remoteAddress: requestAddress(request) })) {
    return HttpServerResponse.empty({ status: 403 });
  }
  if (self === null) return HttpServerResponse.empty({ status: 403 });
  const token = yield* mintAccessToken(self).pipe(Effect.option);
  if (Option.isNone(token)) return HttpServerResponse.empty({ status: 403 });
  if (!wantsBrowserSession(request)) {
    return HttpServerResponse.jsonUnsafe({ accessToken: token.value });
  }
  return yield* issueBrowserCookie(self, request, token.value).pipe(
    Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 403 })),
  );
}).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 403 })));

const linkOrigin = Effect.fn("codrHub.tailnetMesh.linkOrigin")(function* (origin: string) {
  const descriptorText = yield* readHttpText(
    HttpClientRequest.get(new URL("/.well-known/t3/environment", origin).toString()),
  );
  if (descriptorText === null) return null;
  const decoded = yield* decodeDescriptor(parseJson(descriptorText)).pipe(Effect.option);
  if (Option.isNone(decoded)) return null;
  const joinText = yield* readHttpText(
    HttpClientRequest.post(new URL(JOIN_PATH, origin).toString()),
  );
  if (joinText === null) return null;
  const joined = parseJson(joinText);
  if (!isRecord(joined) || typeof joined.accessToken !== "string") return null;
  const token = accessToken(joined.accessToken);
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

const linksForPeer = Effect.fn("codrHub.tailnetMesh.linksForPeer")(function* (peer: TailnetPeer) {
  const bases = [`https://${peer.dnsName}`, `https://${peer.dnsName}:${DEV_SHARE_PORT}`];
  const manifests: unknown[] = [];
  for (const base of bases) {
    const manifestText = yield* readHttpText(
      HttpClientRequest.get(new URL(`${MESH_PREFIX}/codr-hub-mesh`, `${base}/`).toString()),
    );
    if (manifestText !== null) manifests.push(parseJson(manifestText));
  }
  const origins = discoverOrigins(peer.dnsName, manifests);
  const links: MeshLink[] = [];
  for (const origin of origins) {
    const link = yield* linkOrigin(origin).pipe(Effect.orElseSucceed(() => null));
    if (link !== null) links.push(link);
  }
  return links;
});

export const linkTailnet = Effect.fn("codrHub.tailnetMesh.link")(function* () {
  const statusText = yield* tailscaleStdout(["status", "--json"], STATUS_TIMEOUT);
  if (statusText === null) return { links: [] satisfies MeshLink[] };
  const status = parseJson(statusText);
  if (selfPeer(status) === null) return { links: [] satisfies MeshLink[] };
  const groups = yield* Effect.forEach(rosterFromStatus(status), (peer) => linksForPeer(peer), {
    concurrency: 4,
  });
  return { links: groups.flat() };
});

/**
 * Sync with T3 reads stock T3 servers through linked environments (`PeerLinks`): this
 * machine's one as this node, and every other machine's as a node named by the link label.
 */
import {
  type EnvironmentId,
  type HubT3Source,
  NonNegativeInt,
  type PeerLinkSummary,
  Project,
} from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import type { T3ProjectInput } from "./t3Import.ts";

// Only the fields the import reads, so a newer or older stock T3 still decodes.
const T3ProjectPage = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      title: Project.fields.title,
      workspaceRoot: Project.fields.workspaceRoot,
      repositoryIdentity: Project.fields.repositoryIdentity,
    }),
  ),
  nextCursor: Schema.NullOr(NonNegativeInt),
});

const isLoopbackUrl = (url: string) => {
  const parsed = URL.parse(url);
  return parsed !== null && isLocalLoopbackHost(parsed.hostname);
};

/** The linked environment to read, or null for this server's own projects. */
export function pickT3Source(
  source: HubT3Source | undefined,
  links: ReadonlyArray<Pick<PeerLinkSummary, "environmentId" | "urls" | "status">>,
): EnvironmentId | null {
  if (source === "local") return null;
  if (source !== undefined && source !== "auto") return source;
  const onThisMachine = links.filter(
    (link) => link.status !== "expired" && link.urls.some(isLoopbackUrl),
  );
  return onThisMachine.length === 1 ? onThisMachine[0]!.environmentId : null;
}

/** Linked T3s on other machines, read as their own nodes. Never this node's source. */
export function remoteT3Links<
  Link extends Pick<PeerLinkSummary, "environmentId" | "urls" | "status">,
>(links: ReadonlyArray<Link>, own: EnvironmentId | null): Link[] {
  return links.filter(
    (link) =>
      link.status !== "expired" && link.environmentId !== own && !link.urls.some(isLoopbackUrl),
  );
}

/** Every project in a linked environment, read with `t3_project_list` a page at a time. */
export const listLinkedT3Projects = Effect.fn("codrHub.listLinkedT3Projects")(function* (
  client: PeerMcpClient.PeerMcpClient["Service"],
  environmentId: EnvironmentId,
) {
  const projects: T3ProjectInput[] = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page: typeof T3ProjectPage.Type = yield* client.call({
      environmentId,
      tool: "t3_project_list",
      arguments: { cursor, limit: 100 },
      // A read: the narrowest limits, so the link's own access decides.
      limits: { runtimeMode: "approval-required", interactionMode: "plan" },
      success: T3ProjectPage,
    });
    projects.push(...page.projects);
    cursor = page.nextCursor !== null && page.nextCursor > cursor ? page.nextCursor : null;
  }
  return projects;
});

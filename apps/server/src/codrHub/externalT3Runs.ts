/**
 * Reads agent runs from a T3 projection database: this server's own, and the
 * separate T3 install in the OS home when there is one, opened read-only.
 *
 * @module codrHub/externalT3Runs
 */
import * as NodeOS from "node:os";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import {
  RUN_CAP_MS,
  type AgentRunHistoryRow,
  type AgentRunRow,
  type T3WorkspaceRuns,
} from "./insights.ts";

/** Home whose `.t3/userdata/statev2.sqlite` is the external T3 install. */
export const ExternalT3Home = Context.Reference<string>("t3/codrHub/ExternalT3Home", {
  defaultValue: () => NodeOS.homedir(),
});

type ProjectRow = { readonly projectId: string };

/**
 * Every live project and its threads' runs, archived threads included, deleted
 * excluded: each run since `sinceIso`, and older ones summed per thread and provider.
 */
const readRows = Effect.fn("codrHub.readT3Rows")(function* (sinceIso: string, nowIso: string) {
  const sql = yield* SqlClient.SqlClient;
  const workspaces = yield* sql<{ projectId: string; title: string; workspaceRoot: string }>`
    SELECT project_id AS "projectId", title, workspace_root AS "workspaceRoot"
    FROM projection_projects
    WHERE deleted_at IS NULL
  `;
  const recent = yield* sql<AgentRunRow & ProjectRow>`
    SELECT
      thread.project_id AS "projectId",
      run.thread_id AS "threadId",
      COALESCE(run.provider_instance_id, run.provider) AS "provider",
      run.requested_at AS "requestedAt",
      run.completed_at AS "completedAt"
    FROM orchestration_v2_projection_runs AS run
    JOIN orchestration_v2_projection_threads AS thread
      ON thread.thread_id = run.thread_id
    WHERE thread.deleted_at IS NULL
      AND run.requested_at >= ${sinceIso}
  `;
  const history = yield* sql<AgentRunHistoryRow & ProjectRow>`
    SELECT
      thread.project_id AS "projectId",
      run.thread_id AS "threadId",
      COALESCE(run.provider_instance_id, run.provider) AS "provider",
      COUNT(*) AS "runs",
      CAST(SUM(MIN(MAX(ROUND(
        (julianday(COALESCE(run.completed_at, ${nowIso})) - julianday(run.requested_at))
          * 86400000
      ), 0), ${RUN_CAP_MS})) AS INTEGER) AS "ms",
      MAX(run.requested_at) AS "lastRequestedAt"
    FROM orchestration_v2_projection_runs AS run
    JOIN orchestration_v2_projection_threads AS thread
      ON thread.thread_id = run.thread_id
    WHERE thread.deleted_at IS NULL
      AND run.requested_at < ${sinceIso}
    GROUP BY thread.project_id, run.thread_id, COALESCE(run.provider_instance_id, run.provider)
  `;
  return { workspaces, recent, history };
});

/** A path through every symlink, or the path itself when it cannot be resolved. */
export const resolvePath = Effect.fn("codrHub.resolvePath")(function* (raw: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.realPath(raw).pipe(Effect.orElseSucceed(() => path.resolve(raw)));
});

/** Resolves workspace roots after the database is released, so no connection waits on the disk. */
const resolveRoots = Effect.fn("codrHub.resolveT3Roots")(function* (
  rows: Effect.Success<ReturnType<typeof readRows>>,
) {
  const projectsWithRuns = new Set([...rows.recent, ...rows.history].map((row) => row.projectId));
  const workspaces = yield* Effect.forEach(
    rows.workspaces.filter((workspace) => projectsWithRuns.has(workspace.projectId)),
    (workspace) =>
      Effect.map(resolvePath(workspace.workspaceRoot), (root) => ({
        projectId: workspace.projectId,
        title: workspace.title,
        root,
      })),
    { concurrency: 8 },
  );
  return { workspaces, recent: rows.recent, history: rows.history } satisfies T3WorkspaceRuns;
});

/** Runs in the database the ambient `SqlClient` serves, on its reader connection. */
export const readOwnT3Runs = (sinceIso: string, nowIso: string) =>
  readRows(sinceIso, nowIso).pipe(NodeSqliteClient.readOnly, Effect.flatMap(resolveRoots));

/**
 * Runs in the T3 install under `ExternalT3Home`, or null when there is none or
 * it is this server's own database (`ownDbPath`). The file is opened read-only
 * for this read alone: the install's app keeps writing it.
 */
export const readExternalT3Runs = Effect.fn("codrHub.readExternalT3Runs")(function* (input: {
  readonly ownDbPath: string;
  readonly sinceIso: string;
  readonly nowIso: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dbPath = path.join(yield* ExternalT3Home, ".t3", "userdata", "statev2.sqlite");
  if (!(yield* fs.exists(dbPath).pipe(Effect.orElseSucceed(() => false)))) return null;
  const filename = yield* resolvePath(dbPath);
  if (filename === (yield* resolvePath(input.ownDbPath))) return null;
  const rows = yield* readRows(input.sinceIso, input.nowIso).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename, readonly: true })),
    Effect.catch((cause) =>
      Effect.logWarning("Codr-Hub could not read agent runs from the T3 install", {
        filename,
        cause,
      }).pipe(Effect.as(null)),
    ),
  );
  return rows === null ? null : yield* resolveRoots(rows);
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import { ExternalT3Home, readExternalT3Runs } from "./externalT3Runs.ts";

const window = { sinceIso: "2025-06-01T00:00:00.000Z", nowIso: "2026-06-01T00:00:00.000Z" };

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "codr-hub-external-t3-" });
  const dbPath = path.join(home, ".t3", "userdata", "statev2.sqlite");
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
  const read = (ownDbPath: string) =>
    readExternalT3Runs({ ownDbPath, ...window }).pipe(Effect.provideService(ExternalT3Home, home));
  return { home, dbPath, read };
});

it.layer(NodeServices.layer)("codr-hub external T3 runs", (it) => {
  it.effect("reads the install's runs with workspace roots resolved through symlinks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, dbPath, read } = yield* fixture;
      const app = path.join(home, "app");
      yield* fs.makeDirectory(app);
      yield* fs.symlink(app, path.join(home, "app-link"));
      yield* Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO projection_projects
            (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES ('p', 'App', ${path.join(home, "app-link")}, '[]', '2025-01-01', '2025-01-01')
        `;
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads
            (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
             created_at, updated_at, payload_json)
          VALUES ('t', 'p', 't', 'codex', 'full-access', 'default', '2025-01-01', '2025-01-01', '{}')
        `;
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs
            (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at,
             completed_at, payload_json)
          VALUES ('r', 't', 1, 'claudeAgent', 'claudeAgent_home', 'completed',
            '2026-05-01T00:00:00.000Z', '2026-05-01T00:05:00.000Z', '{}')
        `;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

      const result = yield* read(path.join(home, "own.sqlite"));
      expect(result?.workspaces).toEqual([
        { projectId: "p", title: "App", root: yield* fs.realPath(app) },
      ]);
      expect(result?.recent).toEqual([
        {
          projectId: "p",
          threadId: "t",
          provider: "claudeAgent_home",
          requestedAt: "2026-05-01T00:00:00.000Z",
          completedAt: "2026-05-01T00:05:00.000Z",
        },
      ]);
    }),
  );

  it.effect("skips the install when it is this server's own database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, dbPath, read } = yield* fixture;
      yield* fs.writeFileString(dbPath, "");
      const ownLink = path.join(home, "own-link.sqlite");
      yield* fs.symlink(dbPath, ownLink);
      expect(yield* read(ownLink)).toBeNull();
    }),
  );

  it.effect("degrades to no install when it is missing or not a T3 database", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { home, dbPath, read } = yield* fixture;
      const own = path.join(home, "own.sqlite");
      expect(yield* read(own)).toBeNull();
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE unrelated (id TEXT)`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
      expect(yield* read(own)).toBeNull();
    }),
  );
});

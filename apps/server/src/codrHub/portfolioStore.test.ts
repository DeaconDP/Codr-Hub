import * as NodeServices from "@effect/platform-node/NodeServices";
import type { HubProject } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as Store from "./portfolioStore.ts";

const project = (id: string, name: string): HubProject => ({
  id,
  name,
  priority: "high",
  status: "active",
  stage: "develop",
  strategyId: null,
  category: null,
  tags: [],
  repoUrl: null,
  notes: "",
  hosts: {},
  autonomy: 0,
  reviewBudget: 2,
  sortIndex: 0,
  favorite: false,
  archived: false,
  createdAt: "2026-10-05T00:00:00.000Z",
  updatedAt: "2026-10-05T00:00:00.000Z",
});

const node = (root: string, name: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const paths = Store.portfolioPaths(path, path.join(root, name));
    yield* Store.ensurePortfolioRepo(paths);
    return paths;
  });

it.layer(NodeServices.layer)("codr-hub portfolio store", (it) => {
  it.effect("shares projects between two nodes through a git remote", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "codr-hub-store-" });
      const remote = path.join(root, "remote.git");
      yield* fs.makeDirectory(remote);
      yield* Store.git(remote, ["init", "--quiet", "--bare", "-b", "main"]);

      const steve = yield* node(root, "steve");
      yield* Store.writeProject(steve, project("emily-os", "Emily-OS"));
      yield* Store.commitPortfolio(steve, "Add Emily-OS");
      yield* Store.setRemote(steve, remote);
      yield* Store.syncPortfolio(steve);
      expect(yield* Store.readRemote(steve)).toBe(remote);

      const edgar = yield* node(root, "edgar");
      yield* Store.setRemote(edgar, remote);
      yield* Store.syncPortfolio(edgar);
      expect((yield* Store.readProjects(edgar)).map((p) => p.id)).toEqual(["emily-os"]);

      yield* Store.writeProject(edgar, project("wa-bot", "Wa-bot"));
      yield* Store.commitPortfolio(edgar, "Add Wa-bot");
      yield* Store.syncPortfolio(edgar);
      yield* Store.syncPortfolio(steve);
      expect((yield* Store.readProjects(steve)).map((p) => p.id).toSorted()).toEqual([
        "emily-os",
        "wa-bot",
      ]);
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("defaults a missing hub file but refuses to overwrite a corrupt one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "codr-hub-store-" });
      const paths = yield* node(root, "steve");
      expect(yield* Store.readHubFile(paths)).toEqual(Store.EMPTY_HUB_FILE);

      yield* fs.writeFileString(paths.hubFile, "{ not json");
      const result = yield* Effect.result(Store.readHubFile(paths));
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("skips an unreadable project file without touching it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "codr-hub-store-" });
      const paths = yield* node(root, "steve");
      yield* Store.writeProject(paths, project("good", "Good"));
      const bad = path.join(paths.projectsDir, "bad.json");
      yield* fs.writeFileString(bad, '{"id":"bad"}');
      expect((yield* Store.readProjects(paths)).map((p) => p.id)).toEqual(["good"]);
      expect(yield* fs.readFileString(bad)).toBe('{"id":"bad"}');
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );
});

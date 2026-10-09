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

const mesh = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "codr-hub-mesh-" });
  const remote = path.join(root, "remote.git");
  yield* fs.makeDirectory(remote);
  expect((yield* Store.git(remote, ["init", "--quiet", "--bare", "-b", "main"])).code).toBe(0);
  const steve = yield* node(root, "steve");
  yield* Store.writeHubFile(steve, Store.EMPTY_HUB_FILE);
  yield* Store.writeProject(steve, project("shared", "Shared"));
  yield* Store.commitPortfolio(steve, "Seed portfolio");
  yield* Store.setRemote(steve, remote);
  yield* Store.syncPortfolio(steve);
  const edgar = yield* node(root, "edgar");
  yield* Store.setRemote(edgar, remote);
  yield* Store.syncPortfolio(edgar);
  return { steve, edgar, remote };
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

  it.effect("rebases independent edits and keeps node settings out of the remote", () =>
    Effect.gen(function* () {
      const { steve, edgar, remote } = yield* mesh;
      yield* Store.writeNodeFile(steve, { nodeName: "Steve", autopilotEnabled: true, ledger: [] });
      yield* Store.writeNodeFile(edgar, { nodeName: "Edgar", autopilotEnabled: false, ledger: [] });
      yield* Store.writeProject(steve, project("steve", "Steve's project"));
      yield* Store.commitPortfolio(steve, "Steve edit");
      yield* Store.writeProject(edgar, project("edgar", "Edgar's project"));
      yield* Store.commitPortfolio(edgar, "Edgar edit");
      yield* Store.syncPortfolio(edgar);
      yield* Store.syncPortfolio(steve);
      yield* Store.syncPortfolio(edgar);
      expect((yield* Store.readProjects(steve)).map((p) => p.id).toSorted()).toEqual([
        "edgar",
        "shared",
        "steve",
      ]);
      expect(yield* Store.readProjects(edgar)).toEqual(yield* Store.readProjects(steve));
      expect((yield* Store.readNodeFile(steve)).autopilotEnabled).toBe(true);
      expect((yield* Store.readNodeFile(edgar)).autopilotEnabled).toBe(false);
      expect(
        (yield* Store.git(remote, ["ls-tree", "-r", "--name-only", "main"])).stdout,
      ).not.toContain("node.json");
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("retries when another node pushes between pull and push", () =>
    Effect.gen(function* () {
      const { steve, edgar, remote } = yield* mesh;
      yield* Store.writeProject(steve, project("steve", "Steve's project"));
      yield* Store.commitPortfolio(steve, "Steve edit");
      yield* Store.writeProject(edgar, project("edgar", "Edgar's project"));
      yield* Store.commitPortfolio(edgar, "Edgar edit");
      const runner = yield* ProcessRunner.ProcessRunner;
      const context = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
      >();
      let pushes = 0;
      yield* Store.syncPortfolio(steve).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: Effect.fnUntraced(function* (input: ProcessRunner.ProcessRunInput) {
            if (input.cwd === steve.portfolioDir && input.args[0] === "push") {
              pushes += 1;
              if (pushes === 1)
                yield* Store.syncPortfolio(edgar).pipe(
                  Effect.provideContext(context),
                  Effect.orDie,
                );
            }
            return yield* runner.run(input);
          }),
        }),
      );
      expect(pushes).toBe(2);
      yield* Store.syncPortfolio(edgar);
      expect(yield* Store.readProjects(steve)).toEqual(yield* Store.readProjects(edgar));
      expect((yield* Store.git(remote, ["log", "--format=%s", "main"])).stdout).toContain(
        "Steve edit",
      );
      expect((yield* Store.git(remote, ["log", "--format=%s", "main"])).stdout).toContain(
        "Edgar edit",
      );
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("stops retrying a busy remote while retaining both nodes' commits", () =>
    Effect.gen(function* () {
      const { steve, edgar } = yield* mesh;
      yield* Store.writeProject(steve, project("steve", "Steve's project"));
      yield* Store.commitPortfolio(steve, "Steve edit");
      const runner = yield* ProcessRunner.ProcessRunner;
      const context = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner
      >();
      let pushes = 0;
      const result = yield* Store.syncPortfolio(steve).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: Effect.fnUntraced(function* (input: ProcessRunner.ProcessRunInput) {
            if (input.cwd === steve.portfolioDir && input.args[0] === "push") {
              pushes += 1;
              yield* Effect.gen(function* () {
                yield* Store.writeProject(edgar, project(`edgar-${pushes}`, `Edgar ${pushes}`));
                yield* Store.commitPortfolio(edgar, `Edgar edit ${pushes}`);
                yield* Store.syncPortfolio(edgar);
              }).pipe(Effect.provideContext(context), Effect.orDie);
            }
            return yield* runner.run(input);
          }),
        }),
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      expect(pushes).toBe(3);
      yield* Store.syncPortfolio(steve);
      yield* Store.syncPortfolio(edgar);
      expect((yield* Store.readProjects(edgar)).map((p) => p.id).toSorted()).toEqual([
        "edgar-1",
        "edgar-2",
        "edgar-3",
        "shared",
        "steve",
      ]);
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("reports conflicting edits and restores the local branch without losing work", () =>
    Effect.gen(function* () {
      const { steve, edgar, remote } = yield* mesh;
      yield* Store.writeProject(steve, project("shared", "Steve's name"));
      yield* Store.commitPortfolio(steve, "Steve edit");
      const head = (yield* Store.git(steve.portfolioDir, ["rev-parse", "HEAD"])).stdout;
      yield* Store.writeProject(edgar, project("shared", "Edgar's name"));
      yield* Store.commitPortfolio(edgar, "Edgar edit");
      yield* Store.syncPortfolio(edgar);
      const remoteHead = (yield* Store.git(remote, ["rev-parse", "main"])).stdout;
      const result = yield* Effect.result(Store.syncPortfolio(steve));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.message).toContain("conflict");
      expect((yield* Store.git(steve.portfolioDir, ["rev-parse", "HEAD"])).stdout).toBe(head);
      expect((yield* Store.git(remote, ["rev-parse", "main"])).stdout).toBe(remoteHead);
      expect((yield* Store.git(steve.portfolioDir, ["status", "--porcelain"])).stdout).toBe("");
      expect((yield* Store.readProjects(steve))[0]?.name).toBe("Steve's name");
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("leaves an existing manual rebase untouched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { steve, edgar } = yield* mesh;
      yield* Store.writeProject(steve, project("shared", "Steve's name"));
      yield* Store.commitPortfolio(steve, "Steve edit");
      yield* Store.writeProject(edgar, project("shared", "Edgar's name"));
      yield* Store.commitPortfolio(edgar, "Edgar edit");
      yield* Store.syncPortfolio(edgar);
      yield* Store.git(steve.portfolioDir, ["fetch", "origin"]);
      expect((yield* Store.git(steve.portfolioDir, ["rebase", "origin/main"])).code).not.toBe(0);
      const rebaseDir = path.join(steve.portfolioDir, ".git", "rebase-merge");
      const contents = yield* fs.readFileString(path.join(steve.projectsDir, "shared.json"));
      const status = (yield* Store.git(steve.portfolioDir, ["status", "--porcelain"])).stdout;
      expect(yield* fs.exists(rebaseDir)).toBe(true);
      const result = yield* Effect.result(Store.syncPortfolio(steve));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.message).toContain("unfinished git operation");
      expect((yield* Effect.result(Store.commitPortfolio(steve, "Must not commit")))._tag).toBe(
        "Failure",
      );
      expect(yield* fs.exists(rebaseDir)).toBe(true);
      expect(yield* fs.readFileString(path.join(steve.projectsDir, "shared.json"))).toBe(contents);
      expect((yield* Store.git(steve.portfolioDir, ["status", "--porcelain"])).stdout).toBe(status);
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("refuses uncommitted edits without changing files or the remote", () =>
    Effect.gen(function* () {
      const { steve, remote } = yield* mesh;
      yield* Store.writeProject(steve, project("shared", "Unsaved edit"));
      const head = (yield* Store.git(remote, ["rev-parse", "main"])).stdout;
      const result = yield* Effect.result(Store.syncPortfolio(steve));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.message).toContain("uncommitted");
      expect((yield* Store.readProjects(steve))[0]?.name).toBe("Unsaved edit");
      expect((yield* Store.git(remote, ["rev-parse", "main"])).stdout).toBe(head);
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

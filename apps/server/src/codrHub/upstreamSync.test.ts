import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { makeUpstreamSync } from "./upstreamSync.ts";

const git = Effect.fnUntraced(function* (cwd: string, ...args: string[]) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const out = yield* runner.run({ command: "git", args, cwd, timeout: "30 seconds" });
  if (out.code !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
});

const configure = (cwd: string) =>
  Effect.gen(function* () {
    yield* git(cwd, "config", "user.name", "Test");
    yield* git(cwd, "config", "user.email", "test@example.com");
    yield* git(cwd, "config", "commit.gpgsign", "false");
  });

const commitFile = Effect.fnUntraced(function* (cwd: string, file: string, text: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(path.join(cwd, file), text);
  yield* git(cwd, "add", file);
  yield* git(cwd, "commit", "--quiet", "-m", `edit ${file}`);
});

/** Bare upstream (T3) and origin (fork) remotes, a T3 work clone, and the fork checkout. */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "codr-hub-upstream-" });
  const upstream = path.join(root, "upstream.git");
  const origin = path.join(root, "origin.git");
  const t3 = path.join(root, "t3");
  const fork = path.join(root, "fork");
  yield* git(root, "init", "--quiet", "--bare", "-b", "main", upstream);
  yield* git(root, "clone", "--quiet", upstream, t3);
  yield* configure(t3);
  yield* commitFile(t3, "shared.txt", "base\n");
  yield* git(t3, "push", "--quiet", "origin", "HEAD:main");
  yield* git(root, "clone", "--quiet", "--bare", upstream, origin);
  yield* git(root, "clone", "--quiet", origin, fork);
  yield* configure(fork);
  yield* git(fork, "remote", "add", "upstream", upstream);
  yield* commitFile(fork, "fork.txt", "fork\n");
  yield* git(fork, "push", "--quiet", "origin", "main");
  return { origin, t3, fork };
});

it.layer(NodeServices.layer)("codr-hub upstream sync", (it) => {
  it.effect("counts commits behind upstream/main", () =>
    Effect.gen(function* () {
      const { t3, fork } = yield* fixture;
      yield* commitFile(t3, "a.txt", "a\n");
      yield* commitFile(t3, "b.txt", "b\n");
      yield* git(t3, "push", "--quiet", "origin", "HEAD:main");

      const status = yield* makeUpstreamSync(fork).status();
      expect(status).toMatchObject({
        _tag: "Available",
        branch: "main",
        behind: 2,
        ahead: 1,
        clean: true,
        operationInProgress: false,
      });
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("merges upstream and pushes the result to origin", () =>
    Effect.gen(function* () {
      const { origin, t3, fork } = yield* fixture;
      yield* commitFile(t3, "a.txt", "a\n");
      yield* git(t3, "push", "--quiet", "origin", "HEAD:main");

      const result = yield* makeUpstreamSync(fork).merge();
      expect(result).toEqual({ _tag: "Merged", merged: 1, branch: "main", pushError: null });
      expect(yield* git(origin, "rev-parse", "main")).toBe(yield* git(fork, "rev-parse", "HEAD"));
      expect(yield* git(fork, "show", "HEAD:a.txt")).toBe("a");
      expect(yield* makeUpstreamSync(fork).merge()).toEqual({ _tag: "UpToDate" });
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("aborts a conflicting merge and lists the files", () =>
    Effect.gen(function* () {
      const { origin, t3, fork } = yield* fixture;
      yield* commitFile(t3, "shared.txt", "upstream\n");
      yield* git(t3, "push", "--quiet", "origin", "HEAD:main");
      yield* commitFile(fork, "shared.txt", "fork\n");
      const before = yield* git(fork, "rev-parse", "HEAD");
      const originBefore = yield* git(origin, "rev-parse", "main");

      const result = yield* makeUpstreamSync(fork).merge();
      expect(result).toEqual({ _tag: "Conflict", files: ["shared.txt"] });
      expect(yield* git(fork, "rev-parse", "HEAD")).toBe(before);
      expect(yield* git(fork, "status", "--porcelain")).toBe("");
      expect(yield* git(origin, "rev-parse", "main")).toBe(originBefore);
      const status = yield* makeUpstreamSync(fork).status();
      expect(status).toMatchObject({ operationInProgress: false, clean: true });
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("refuses to merge into a dirty checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { t3, fork } = yield* fixture;
      yield* commitFile(t3, "a.txt", "a\n");
      yield* git(t3, "push", "--quiet", "origin", "HEAD:main");
      yield* fs.writeFileString(path.join(fork, "fork.txt"), "unsaved\n");
      const before = yield* git(fork, "rev-parse", "HEAD");

      const error = yield* Effect.flip(makeUpstreamSync(fork).merge());
      expect(error.message).toContain("uncommitted changes");
      expect(yield* git(fork, "rev-parse", "HEAD")).toBe(before);
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );

  it.effect("reports unavailable outside a checkout with an upstream remote", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const plain = yield* fs.makeTempDirectoryScoped({ prefix: "codr-hub-plain-" });
      expect(yield* makeUpstreamSync(plain).status()).toMatchObject({ _tag: "Unavailable" });
    }).pipe(Effect.provide(ProcessRunner.layer)),
  );
});

/**
 * The portfolio on disk: a git repo of JSON files shared across mesh nodes,
 * plus one node-local file that is never synced. Layout and the reasons for
 * it are in docs/codr-hub/ARCHITECTURE.md#data.
 *
 * @module codrHub/portfolioStore
 */
import * as NodeOS from "node:os";

import {
  DEFAULT_HUB_SETTINGS,
  HubError,
  HubLaunchRecord,
  HubProject,
  HubSettings,
  HubStrategyPriority,
} from "@t3tools/contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ProcessRunner } from "../processRunner.ts";

export const HubFile = Schema.Struct({
  version: Schema.Literal(1),
  strategy: Schema.Array(HubStrategyPriority),
  settings: HubSettings,
});
export type HubFile = typeof HubFile.Type;

export const EMPTY_HUB_FILE: HubFile = { version: 1, strategy: [], settings: DEFAULT_HUB_SETTINGS };

export const NodeFile = Schema.Struct({
  nodeName: Schema.String,
  autopilotEnabled: Schema.Boolean,
  ledger: Schema.Array(HubLaunchRecord),
});
export type NodeFile = typeof NodeFile.Type;

export interface PortfolioPaths {
  readonly root: string;
  readonly portfolioDir: string;
  readonly projectsDir: string;
  readonly hubFile: string;
  readonly nodeFile: string;
}

export const portfolioPaths = (path: Path.Path, stateDir: string): PortfolioPaths => {
  const root = path.join(stateDir, "codr-hub");
  const portfolioDir = path.join(root, "portfolio");
  return {
    root,
    portfolioDir,
    projectsDir: path.join(portfolioDir, "projects"),
    hubFile: path.join(portfolioDir, "hub.json"),
    nodeFile: path.join(root, "node.json"),
  };
};

export const defaultNodeName = () => NodeOS.hostname().replace(/\.local$/i, "") || "node";

const hubError = (message: string) => (cause: unknown) => new HubError({ message, cause });

const decodeHubFile = Schema.decodeUnknownEffect(HubFile);
const decodeNodeFile = Schema.decodeUnknownEffect(NodeFile);
const decodeProjectJson = Schema.decodeUnknownEffect(Schema.fromJsonString(HubProject));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const toJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const readJsonOr = <A>(file: string, fallback: A) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(file))) return fallback as unknown;
    return yield* decodeJson(yield* fs.readFileString(file));
  });

/**
 * A file that exists but cannot be decoded fails loudly instead of falling
 * back to defaults, so a bad merge never silently wipes the owner's data.
 */
export const readHubFile = (paths: PortfolioPaths) =>
  readJsonOr(paths.hubFile, null).pipe(
    Effect.flatMap((raw) => {
      if (raw === null) {
        return Effect.succeed(EMPTY_HUB_FILE);
      }
      const record = raw as { settings?: Record<string, unknown> };
      // New settings get defaults so older files keep decoding.
      return decodeHubFile({
        ...record,
        settings: { ...DEFAULT_HUB_SETTINGS, ...record.settings },
      });
    }),
    Effect.mapError(hubError(`Could not read ${paths.hubFile}.`)),
  );

export const readNodeFile = (paths: PortfolioPaths) =>
  readJsonOr(paths.nodeFile, null).pipe(
    Effect.flatMap((raw) =>
      raw === null
        ? Effect.succeed<NodeFile>({
            nodeName: defaultNodeName(),
            autopilotEnabled: false,
            ledger: [],
          })
        : decodeNodeFile(raw),
    ),
    Effect.mapError(hubError(`Could not read ${paths.nodeFile}.`)),
  );

/** Undecodable project files are skipped with a warning and left untouched on disk. */
export const readProjects = (paths: PortfolioPaths) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(paths.projectsDir))) return [];
    const names = (yield* fs.readDirectory(paths.projectsDir)).filter((name) =>
      name.endsWith(".json"),
    );
    const projects = yield* Effect.forEach(names, (name) =>
      fs.readFileString(path.join(paths.projectsDir, name)).pipe(
        Effect.flatMap(decodeProjectJson),
        Effect.map((project) => [project]),
        Effect.catch((cause) =>
          Effect.logWarning("Skipping unreadable Codr-Hub project file", { name, cause }).pipe(
            Effect.as([] as HubProject[]),
          ),
        ),
      ),
    );
    return projects.flat();
  }).pipe(Effect.mapError(hubError("Could not read portfolio projects.")));

export const writeHubFile = (paths: PortfolioPaths, hub: HubFile) =>
  writeFileStringAtomically({ filePath: paths.hubFile, contents: toJson(hub) }).pipe(
    Effect.mapError(hubError("Could not save hub settings.")),
  );

export const writeNodeFile = (paths: PortfolioPaths, node: NodeFile) =>
  writeFileStringAtomically({ filePath: paths.nodeFile, contents: toJson(node) }).pipe(
    Effect.mapError(hubError("Could not save node settings.")),
  );

export const projectFile = (path: Path.Path, paths: PortfolioPaths, id: string) =>
  path.join(paths.projectsDir, `${id}.json`);

export const writeProject = (paths: PortfolioPaths, project: HubProject) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* writeFileStringAtomically({
      filePath: projectFile(path, paths, project.id),
      contents: toJson(project),
    });
  }).pipe(Effect.mapError(hubError(`Could not save project ${project.name}.`)));

export const removeProject = (paths: PortfolioPaths, id: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = projectFile(path, paths, id);
    if (yield* fs.exists(file)) yield* fs.remove(file);
  }).pipe(Effect.mapError(hubError("Could not delete the project.")));

// --- git ---------------------------------------------------------------------

export const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  timeout: Duration.Input = "30 seconds",
) =>
  Effect.gen(function* () {
    const runner = yield* ProcessRunner;
    return yield* runner.run({ command: "git", args, cwd, timeout });
  }).pipe(Effect.mapError(hubError(`git ${args[0]} failed.`)));

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

const gitOk = (cwd: string, args: ReadonlyArray<string>) =>
  git(cwd, args).pipe(
    Effect.flatMap((out) =>
      out.code === 0
        ? Effect.succeed(out.stdout)
        : Effect.fail(
            new HubError({
              message: `git ${args.join(" ")}: ${firstLine(out.stderr) || `exit ${out.code}`}`,
            }),
          ),
    ),
  );

/** Creates the portfolio repo on first run. Commits need an identity, so a missing one gets a local fallback. */
export const ensurePortfolioRepo = (paths: PortfolioPaths) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(paths.projectsDir, { recursive: true });
    if (!(yield* fs.exists(path.join(paths.portfolioDir, ".git")))) {
      yield* gitOk(paths.portfolioDir, ["init", "--quiet", "-b", "main"]);
    }
    const email = yield* git(paths.portfolioDir, ["config", "user.email"]);
    if (email.stdout.trim() === "") {
      yield* gitOk(paths.portfolioDir, ["config", "user.name", "Codr-Hub"]);
      yield* gitOk(paths.portfolioDir, ["config", "user.email", "codr-hub@localhost"]);
    }
  }).pipe(Effect.mapError(hubError("Could not prepare the portfolio repo.")));

/** Commits everything; an empty commit is not an error. */
export const commitPortfolio = (paths: PortfolioPaths, message: string) =>
  Effect.gen(function* () {
    yield* gitOk(paths.portfolioDir, ["add", "-A"]);
    const status = yield* gitOk(paths.portfolioDir, ["status", "--porcelain"]);
    if (status.trim() === "") return;
    yield* gitOk(paths.portfolioDir, ["commit", "--quiet", "-m", message]);
  });

export const readRemote = (paths: PortfolioPaths) =>
  git(paths.portfolioDir, ["remote", "get-url", "origin"]).pipe(
    Effect.map((out) => (out.code === 0 && out.stdout.trim() !== "" ? out.stdout.trim() : null)),
    Effect.orElseSucceed(() => null),
  );

export const setRemote = (paths: PortfolioPaths, remote: string | null) =>
  Effect.gen(function* () {
    const current = yield* readRemote(paths);
    if (remote === null) {
      if (current !== null) yield* gitOk(paths.portfolioDir, ["remote", "remove", "origin"]);
      return;
    }
    yield* gitOk(
      paths.portfolioDir,
      current === null
        ? ["remote", "add", "origin", remote]
        : ["remote", "set-url", "origin", remote],
    );
  });

/**
 * Pull (rebase) then push. A conflict stops the rebase and is reported; it is
 * never resolved automatically.
 */
export const syncPortfolio = (paths: PortfolioPaths) =>
  Effect.gen(function* () {
    // symbolic-ref also works before the first commit, when a node joins empty.
    const branch = (yield* gitOk(paths.portfolioDir, ["symbolic-ref", "--short", "HEAD"])).trim();
    yield* gitOk(paths.portfolioDir, ["fetch", "--quiet", "origin"]);
    const remoteHas = yield* git(paths.portfolioDir, [
      "rev-parse",
      "--verify",
      "--quiet",
      `origin/${branch}`,
    ]);
    if (remoteHas.code === 0) {
      const pulled = yield* git(paths.portfolioDir, [
        "pull",
        "--rebase",
        "--quiet",
        "origin",
        branch,
      ]);
      if (pulled.code !== 0) {
        yield* git(paths.portfolioDir, ["rebase", "--abort"]);
        return yield* new HubError({
          message: `Portfolio sync conflict; resolve it in ${paths.portfolioDir}. ${firstLine(pulled.stderr)}`,
        });
      }
    }
    const hasCommits = yield* git(paths.portfolioDir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (hasCommits.code !== 0) return;
    yield* gitOk(paths.portfolioDir, ["push", "--quiet", "-u", "origin", branch]);
  });

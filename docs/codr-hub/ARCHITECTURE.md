# Codr-Hub architecture

Read [BRIEF.md](BRIEF.md) first. This page covers how Codr-Hub sits inside T3 Code, and the constraints you would get wrong without it. T3's own architecture is in [docs/internals/overview.md](../internals/overview.md).

## Fork seams

Upstream T3 Code lands about 40 commits a day. Every line we change in an upstream file is a future merge conflict. The rules:

1. Codr-Hub code lives in **its own files**: `apps/server/src/codrHub/`, `packages/contracts/src/codrHub.ts`, `apps/web/src/components/hub/`, `apps/web/src/routes/hub.tsx`, and `docs/codr-hub/`.
2. Upstream files only get **hook-in lines**: an import plus a registration line or a contiguous block. Never refactor or reformat upstream code while you are in there.
3. Every upstream file we touch is listed below. If you add a seam, add it here; if you remove one, delete it here.
4. No SQLite migrations. Portfolio data lives in files (see [Data](#data)), so T3's migration numbering is never contested.

| Upstream file                                        | Hook                                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/contracts/src/index.ts`                    | `export * from "./codrHub.ts"`                                                          |
| `packages/contracts/src/rpc.ts`                      | `WS_METHODS` hub entries, plus one block of `Rpc.make` definitions added to the group   |
| `apps/server/src/ws.ts`                              | Hub handlers block                                                                      |
| `apps/server/src/auth/RpcAuthorization.ts`           | Scope per hub method                                                                    |
| `apps/server/src/orchestration-v2/runtimeLayer.ts`   | Provides `CodrHubService`                                                               |
| `packages/client-runtime/src/rpc/client.ts`          | Hub subscription tag                                                                    |
| `packages/client-runtime/src/state/server.ts`        | Hub atoms                                                                               |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`  | "Hub" utility item                                                                      |
| `apps/web/src/components/sidebar/mainAppLocation.ts` | `/hub` counts as a utility page                                                         |
| `apps/web/src/routeTree.gen.ts`                      | Generated; regenerates on build                                                         |
| `AGENTS.md`                                          | Codr-Hub section at the end                                                             |
| `README.md`                                          | One-click `run.command` / `run.bat` note after `vp i`                                   |
| `docs/operations/development.md`                     | One-click launcher paragraph (sticky 5733 / 13773)                                      |
| `apps/mobile/app.config.ts`                          | `T3CODE_IOS_APPLE_TEAM_ID` plus existing personal-team bundle/capability path           |
| `apps/web/src/components/chat/MessagesTimeline.tsx`  | `LiveActivityRow` ref uses `useLiveStageCueRef` (E9 stage cues, `apps/web/src/codrHub`) |

### Syncing upstream

```sh
git fetch upstream
git merge upstream/main   # never rebase shared branches
```

Resolve conflicts in the seam files above by re-applying the hook. Then run the hub tests (`vp test run apps/server/src/codrHub apps/web/src/components/hub`), typecheck `packages/contracts`, `packages/client-runtime`, `apps/server`, and `apps/web`, and regenerate `routeTree.gen.ts` (any `vp run dev` does it).

## Data

The portfolio is a directory of JSON files that is also a git repo:

```
<T3 state dir>/codr-hub/portfolio/ git repo (clone of the owner's private repo)
  hub.json                         strategy priorities (ordered) + shared hub settings
  projects/<id>.json               one file per project, so mesh edits rarely conflict
<T3 state dir>/codr-hub/node.json  this node only: node name, autopilot on/off, launch ledger
<T3 state dir>/codr-hub/quota-node-id  stable identity for pacing ownership on this node
```

`<T3 state dir>` is `~/.t3/userdata` for an installed server, and `<home-dir>/userdata` for a dev server started with `--home-dir`.

- One file per project is deliberate. Two nodes editing different projects never conflict in git.
- `node.json` and `quota-node-id` are never synced. Preserve both on restart; do not copy them to another node. The ledger retains running or unreviewed threads beyond its recent-history limit, and pins each launch to its account even when provider instances change. An unreadable ledger blocks pacing and ownership release until repaired.
- Each write commits locally. If a remote is configured, `sync` does `pull --rebase` then `push`, retrying a competing push up to three attempts. A conflict restores the local branch and is reported to the user; neither node's edits are auto-resolved. Uncommitted edits or a manual git operation block sync.
- Portfolio mutations and sync share one lock through snapshot reload. Read the current snapshot after acquiring that lock, or a queued edit can overwrite fields just pulled from another node.
- A project's local checkout is keyed by node name: `hosts: { "Steve": { path } }`. A path from one machine means nothing on another.
- A portfolio project is **not** a T3 project. T3 projects are local to one environment. The hub links them at runtime by matching `hosts[thisNode].path` to a T3 project's workspace root, and creates the T3 project when the autopilot first needs it.

## Autopilot

The autopilot is a T3 `Scheduler` source on each server. Every tick it does the following:

1. Reads usage windows and banked resets from `ProviderRegistry.getProviders`. These are T3's existing probes, so there is no new scraping.
2. Works out a **pace** in `codrHub/pacing.ts`, a pure function. Local instances of the same provider/account share usage windows and running counts:
   - The target curve reaches 95% (configurable) at the window's reset. It is convex, so the push grows as the reset nears.
   - The longest window sets the budget curve; shorter windows can cap spending.
   - Any window at or above the cap pauses that provider until it resets.
   - Banked resets add capacity. They are only auto-deployed if the owner turns that on, and only when a credit would otherwise expire unused.
3. Picks work in `codrHub/selection.ts`, also a pure function. Eligible projects are active, have autonomy above 0%, have a path on this node, and are under their review budget. They are ranked by strategy order, then priority, then manual order.
4. Verifies account ownership on the portfolio remote before launching or automatically redeeming a reset. Run once uses the same gate.
5. Reserves a thread ID in the node ledger before dispatching through T3's `ThreadLaunchService`, so a lost reply cannot hide running work. The prompt comes from the project's SDLC stage template. A thread counts against the review budget until settled or archived; archived running or background work still prevents ownership release.

### Autonomy ladder

The UI shows autonomy as a percentage, but it maps to T3 runtime primitives in steps:

| Level          | Launch settings                                       | Agent may                                                          |
| -------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| 0% Off         | —                                                     | Nothing is launched                                                |
| 25% Plan       | `plan` interaction, root workspace, approval-required | Propose a plan. No edits.                                          |
| 50% Supervised | Worktree, approval-required                           | Edit, with each tool call approved by the owner                    |
| 75% Draft PR   | Worktree, full-access                                 | Edit, test, commit, and open a draft PR. Never merge.              |
| 100% Full auto | Worktree, full-access                                 | All of the above, then merge to the default branch once tests pass |

The prompt states the level's limits, but the runtime settings above are what actually enforce them. Prompt text alone is not a control.

## Mesh

Every node runs its own T3 server and autopilot. Clients reach any node over Tailscale (`t3 serve --tailscale-serve`, or `vp run dev --share` in dev). Portfolio sync and pacing coordination use the existing private git remote; they do not require a new mesh service.

All nodes sharing a subscription must run the ownership-aware version and use the same portfolio remote. Account identity is the hash of provider driver and normalized authenticated email, independent of instance IDs. Providers without that identity cannot pace with a remote configured. With no remote, pacing remains local and has no cross-node guarantee. This coordinates Hub launches and automatic resets, not manually started agents or manual reset redemption.

Ownership lives on `refs/heads/codr-hub-quota/<account hash>`, outside `main`, with only a version, stable node ID, and display name. Atomic creation uses an explicit empty-ref lease; release uses the observed object ID as a lease. Never replace an existing owner or delete a ref without that comparison. Local `refs/codr-hub-quota/<remote hash>/<account hash>` record claim intent before a push, so even a lost push reply can be recovered and released after restart. Preserve these local refs with the portfolio repository.

Owners do not expire. Launches pause if the remote cannot verify ownership. Turning Autopilot off releases this node's claims on a subsequent minute tick only after its launched work is finished and settled or archived. Thread-state failures block release. Changing the remote uses the same drain requirement and releases claims on the old remote first. An offline owner must be recovered for normal handover; automatic timeout takeover would permit paused work to resume alongside another owner.

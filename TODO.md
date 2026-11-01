# Codr-Hub TODO

Active work for E1 (v0.1) and E2 (mesh hardening). Check items off as they land. Deferred items go to [ROADMAP.md](ROADMAP.md#deferred).

## Step 4: Brief & docs

- [x] Fork T3 Code → DeaconDP/Codr-Hub, `upstream` remote
- [x] Grill session; decisions recorded in `docs/codr-hub/BRIEF.md`
- [x] `docs/codr-hub/ARCHITECTURE.md` (fork seams, data, autopilot)
- [x] AGENTS.md pointer to Codr-Hub docs

## Step 5: Build v0.1

- [x] Toolchain: Node 24 + `vp i`, dev server boots on Steve
- [x] Contracts: `packages/contracts/src/codrHub.ts` + RPC methods
- [x] Server: portfolio store (files + git commit/sync)
- [x] Server: Deez-PM import
- [x] Server: pacing (pure, tested)
- [x] Server: project selection (pure, tested)
- [x] Server: autopilot scheduler source + launch ledger + review budget
- [x] Server: banked reset deploy (reuse T3 `provider.consumeResetCredit`)
- [x] Server: git glance per project path
- [x] Wire: ws handlers, auth scopes, runtime layer, client-runtime atoms
- [x] Web: `/hub` route + sidebar item (command palette deferred, see ROADMAP)
- [x] Web: project table (sort/filter/inline edit), strategy list, pace panel, autopilot toggle, settings
- [x] User doc `docs/user/codr-hub.md`
- [x] Targeted tests + typecheck + lint for touched scope

## Step 6: Hand off

- [x] Import real Deez-PM projects in a dev instance; verify desktop and 390px mobile layout; one plan-only autopilot run on a scratch repo
- [x] Human-testing checklist for the owner (below)

## Human testing (owner)

- [ ] Start dev on Steve and open Hub from the sidebar (desktop and phone over Tailscale with `--share`)
- [ ] Import from Deez-PM, then fix the "Path missing" checkouts for the projects you care about
- [ ] Add 2–3 strategy priorities, link projects, and check the ranking feels right
- [ ] Set one real project to 25% (Plan), click Run once, and review the thread
- [ ] Try 75% (Draft PR) on a low-stakes repo; confirm it works in a worktree and opens a draft PR
- [ ] Turn the Autopilot on for an hour and watch pace, review budget, and launches
- [x] Create the private portfolio repo: `DeaconDP/codr-hub-portfolio`, seeded with the 22 imported projects
- [ ] On each node: set Portfolio git remote to `https://github.com/DeaconDP/codr-hub-portfolio.git`, then Save & sync
- [ ] Decide: Deploy reset by hand on Codex (2 banked) when it next caps

## E2: Mesh sync hardening

- [x] Retry competing portfolio pushes without overwriting another node's commits
- [x] Preserve local edits and manual git operations when sync cannot proceed
- [x] Serialize portfolio mutations with sync and snapshot reload, including a failed push after a successful pull
- [x] Focused multi-node git and service concurrency tests (15 passed), server typecheck, targeted lint
- [ ] Owner: verify Save & sync on each real mesh node
- [ ] E2: other Codr-Hub machines on the same Tailscale account show up while the app is open

## E2: Shared subscription pacing

- [x] Atomic account ownership through the portfolio remote, with a stable local node identity
- [x] Gate launches, Run once, and automatic banked resets on verified ownership
- [x] Share local account concurrency across provider instances; show ownership and blocked reasons
- [x] Release ownership after Autopilot is off and its threads have drained; preserve ownership across restart/offline
- [x] Focused multi-node ownership and autopilot integration tests (16 new tests; 52 Hub tests passed), server typecheck, targeted lint
- [ ] Owner: verify one pacing owner and handover between real mesh nodes on the same subscription

## Dev launcher

- [x] One-click `run.command` / `run.bat` (Node 24, `vp i`, sticky http://localhost:5733)

## Setup simplification

- [x] README.md: Codr-Hub section and five-step Quick start on top; upstream T3 content kept below under "Upstream T3 Code"
- [x] `docs/user/codr-hub.md`: "Getting started" is the one first-run walkthrough, linking to deeper sections
- [x] Development "First checkout", fleet ops doc, and mobile README lead with the launcher and `npm run codr:*` scripts
- [ ] Owner: set up a fresh machine from the README Quick start alone and note any step that needed more

## E3: Per-project kanban (in progress)

- [x] Contracts: HubTask, columns, HubBoardSnapshot, HubBoardCommand + board RPCs
- [x] Pure board.ts (reduceBoard / projectBoard / mintRank / Deez map) + focused tests
- [x] portfolioStore task file I/O + CodrHubService subscribeBoard/applyBoard under writeLock
- [x] Wire: ws, auth scopes, client-runtime hubBoardLive / hubBoardApply
- [x] Web: `/hub/projects/$projectId/board` route + streamlined four-column board
- [x] Deez import: tasks remap UUID→slug, 5→4 columns, skip existing deezCardId
- [x] Docs: ARCHITECTURE data note + user doc section; fork-seams if new hooks
- [x] Verify: focused board/deezImport/hubBoardMove tests (19) + contracts typecheck
- [ ] Browser pass with owner go-ahead: Board create/drag/edit/delete at desktop and ~390px
- [ ] Land https://github.com/DeaconDP/Codr-Hub/pull/4 into codr-hub/v0.1

## E3: Site fleet (in progress)

- [x] Contracts: previewUrl, liveUrl on HubProject; stickyPort + launchCmd on HubProjectHost (node-local)
- [x] Optional siteId/surface for product family; skip OpenShip verbs in this slice
- [x] Upsert + Deez import map for the new fields; merge this-node sticky/launch
- [x] Hub dialog + table glance links (Preview / Live; muted port/cmd; no Run/OpenShip)
- [x] Docs + focused tests (stacked on kanban, branch `codr-hub/e3-site-fleet`)
- [ ] Land https://github.com/DeaconDP/Codr-Hub/pull/5 into codr-hub/v0.1

## Job kind, model policy, pace targets (uncommitted)

- [x] Contracts: HubJobKind + HubLane; per-provider `paceTargets` in HubSettings (Claude, Cursor, Codex, fallback; 95% default)
- [x] `codrHub/modelPolicy.ts`: model per job kind, fix handoff forces Edit, availability/reset can postpone
- [x] Web: lanes + per-provider targets in HubPacePanel / HubSettingsPanel
- [ ] Owner: per-provider pace targets feel right

## Owner test gate (uncommitted)

- [x] `codrHub/testHandoff.ts` + durable `handoffs/<id>.json`; Ship clears, Fix reserves for one thread
- [x] `selection.ts` skips projects awaiting a verdict
- [x] Web: HubTestQueue (Ship / Fix)
- [ ] Owner: try Ship and Fix on a real project

## Fleet supervisor (uncommitted)

- [x] `scripts/codr-hub-fleet/` parent: fetch, fast-forward, install, idle restart via explicit home
- [x] `codrHub/fleetDecide.ts`, `fleetLogin.ts`; HubFleetReport in snapshot
- [x] Ops doc `docs/operations/codr-hub-fleet.md`
- [ ] Owner: arm on each node (`npm run codr:always-on`) and watch one fast-forward

## Mobile build (uncommitted)

- [x] iOS device script renamed to CodrHubDev
- [x] `patches/expo-modules-jsi@58.0.7.patch` for Swift 6.4

## Land the uncommitted work

- [x] Focused tests pass: server Hub 104, contracts 6, web hub 12, fleet scripts 16
- [ ] Commit in slices (contracts first) so codr-hub/v0.1 builds clean
- [ ] Rebase PR #4/#5 onto those commits (committed CodrHubService imports modelPolicy/testHandoff/fleetDecide)

## Project picker (uncommitted)

- [x] Contracts: `HubSettings.nodeColors`, per-node colour patch, `hub.upsertProjects` batch
- [x] Server: shared upsert step; batch lands as one commit (3 new tests)
- [x] Web: `HubProjectPicker` in the new-thread hero: favourites, tags + tag filter, search, drag / Alt+↑/↓ reorder, rename, colour-coded machine icons, Machine colours dialog
- [x] `projectPickerModel.ts` linking / ordering / reorder plan (9 tests); web, server, contracts, client-runtime typecheck; targeted lint
- [ ] Browser pass with owner go-ahead: picker at desktop and ~390px, drag, rename, tags, colours across two nodes

## Import from T3 (uncommitted)

- [x] `hub.import` source `t3`: pure `codrHub/t3Import.ts` links by path, then repo, then name; fills missing checkouts; adds the rest at autonomy 0 (5 new tests)
- [x] Web: **Import from T3** beside **Import from Deez-PM** in the Projects table
- [ ] Owner: Import from T3 on each node and check nothing is duplicated

## Sync with T3 (uncommitted)

- [x] Per-node `syncT3` in `node.json`, set through `hub.setNode`; snapshot carries `t3Sync` (enabled, last run, result, error)
- [x] Server: while on, watches committed T3 project events (no polling), coalesces bursts, runs the T3 merge under the write lock; runs once on startup and when turned on
- [x] Server: adds this node's live, unarchived Hub checkouts to T3 via `ProjectService.create`; skips roots T3 already knows or the owner removed; never deletes
- [x] Pure `planT3Creates` in `codrHub/t3Import.ts` (2 tests); service test for enable + event-driven sync
- [x] Web: **Sync with T3** switch in Hub settings; **Import from T3** reads **Sync now** while on, last sync result above the list
- [ ] Owner: turn on Sync with T3 on each node; add a project in T3 and a checkout in the Hub, check both appear once

## Next engineering slice

- [x] E2: merge the Hub project view across connected environments
- [x] E9: motion policy note (`docs/codr-hub/MOTION.md`)
- [x] E9: Hub running badge, one visibility-gated shine per active project
- [x] E9: chat live-row enter / complete / fail cues (`apps/web/src/codrHub/liveStageCue.ts`, 4 tests), web typecheck, targeted lint
- [ ] Owner: check E9 by hand on a high-refresh display (live shine, offscreen and hidden-tab pause, Reduce motion, one Hub badge per job)

## Hub dashboard

- [x] `hub.insights` RPC: per-node platform detection (tags + checkout files) and commit counts for 24h / 7d / 30d / YTD / all, cached 5 min
- [x] `/hub/dashboard`: treemap grouped by machine, sized by importance or activity, coloured by platform, with a platform filter
- [ ] Owner: open Hub → Dashboard on desktop and phone; check platform detection on Unreal/Unity/iOS checkouts and correct tags where it's wrong

## Upstream update (uncommitted)

- [x] `codrHub/upstreamSync.ts`: fetch `upstream`, behind/ahead/clean status; merge `upstream/main`, abort on conflict with file list, push to `origin` (no force); serialized
- [x] `hub.upstream.status` / `hub.upstream.merge` RPCs, admin scopes (`access:read` / `access:write`)
- [x] Hub settings: **Update from T3 Code** row (Check, Merge & push, blocker reason, conflict list)
- [x] Temp-repo tests: behind count, merge + push, conflict aborted, dirty refused, unavailable (5)
- [ ] Owner: Check and Merge & push from the desktop startup link; watch a fleet node fast-forward

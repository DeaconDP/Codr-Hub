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

## E2: Shared subscription pacing

- [x] Atomic account ownership through the portfolio remote, with a stable local node identity
- [x] Gate launches, Run once, and automatic banked resets on verified ownership
- [x] Share local account concurrency across provider instances; show ownership and blocked reasons
- [x] Release ownership after Autopilot is off and its threads have drained; preserve ownership across restart/offline
- [x] Focused multi-node ownership and autopilot integration tests (16 new tests; 52 Hub tests passed), server typecheck, targeted lint
- [ ] Owner: verify one pacing owner and handover between real mesh nodes on the same subscription

## Dev launcher

- [x] One-click `run.command` / `run.bat` (Node 24, `vp i`, sticky http://localhost:5733)

## Next engineering slice

- [x] E2: merge the Hub project view across connected environments
- [x] E9: motion policy note (`docs/codr-hub/MOTION.md`)
- [x] E9: Hub running badge, one visibility-gated shine per active project
- [x] E9: chat live-row enter / complete / fail cues (`apps/web/src/codrHub/liveStageCue.ts`, 4 tests), web typecheck, targeted lint
- [ ] Owner: check E9 by hand on a high-refresh display (live shine, offscreen and hidden-tab pause, Reduce motion, one Hub badge per job)

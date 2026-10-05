# Codr-Hub TODO

Active work for epic E1 (v0.1). Check items off as they land. Deferred items go to [ROADMAP.md](ROADMAP.md#deferred).

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

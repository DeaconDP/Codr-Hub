# Codr-Hub roadmap

Epics and deferred work. Active tasks are in [TODO.md](TODO.md). Brief: [docs/codr-hub/BRIEF.md](docs/codr-hub/BRIEF.md).

## Epics

### E1. v0.1 Portfolio + Autopilot (in progress)

Portfolio store (git-backed), strategy list, project table, Deez-PM import, pacing, autopilot, hub page on web/mobile-web. Done when every point of "v0.1 done means" in the brief passes human testing.

### E2. Mesh hardening (in progress)

- Portfolio sync hardening implemented: bounded retries for competing pushes, preservation of local commits and manual git operations, and serialized edits through snapshot reload. Focused local multi-node tests cover these paths.
- Verify push and pull of the portfolio repo to the private remote from every real node (owner acceptance pending).
- Shared subscription pacing implemented: one owner per provider/account, claimed atomically through the portfolio remote. Scheduled launches, Run once, and automatic banked resets require verified ownership; local instances share concurrency. Ownership survives restarts and releases after Autopilot is off and its work drains. Verified with 16 new ownership/integration tests and all 52 focused Hub tests.
- Verify ownership and handover between real mesh nodes (owner acceptance pending).
- Hub view across environments: client-side union of live Hub snapshots by project id, with per-node checkout overlay. Owner mesh acceptance can stay pending.
- Other Codr-Hub machines on the same Tailscale account are saved while the app is open.

### E3. Fold in Deez-Project-Manager

Kanban tasks per project (PR #4) and site fleet: preview/live URLs, sticky ports, launch commands (PR #5), both implemented, PRs open. Remaining: the machine monitor, Unity Hub/VCC imports, tags and saved views.

### E4. Fold in Cursor-Hub

Wake-on-LAN through an awake LAN peer, a Tauri-style tray and autostart (T3 desktop already has some of this), and a Cursor IDE transcript mirror.

Git self-update with fan-out is done: fleet parents fast-forward each node from `origin`, and Update from T3 Code (Hub settings) merges upstream and pushes to `origin`.

### E5. Fold in Deez-Fuel-Gauge

An always-on usage overlay or compact widget. Extra providers that T3 doesn't probe (OpenRouter, fal.ai, xAI billing).

### E6. Native mobile hub

A hub screen in `apps/mobile`, with push notifications when autopilot work needs review.

### E7. Strategy and research layer

Problems → priorities → projects, a research agent per priority, and a Notion sync for strategy notes.

### E8. Distribution

Codr-Hub branding, a website, and downloadable builds, for when other coders join.

### E9. Performant agent-task micro-animations (in progress)

Complex motion that still keeps the app fast. Put almost all continuous animation on live agent work. Keep idle chrome still.

**Rules**

- Animate `transform` / opacity / clipped text gradients only. No layout thrash. No motion library for product chrome.
- Continuous loops only while a turn, tool, thinking, compacting, worktree setup, browser session, or Hub autopilot job is actually running. Off the moment it ends.
- Gate loops with `observeVisibleAnimation` (`apps/web/src/lib/visibleAnimation.ts`): pause when offscreen, tab hidden, or `prefers-reduced-motion`.
- Reuse `live-tool-shine` / `live-activity-focus` in `apps/web/src/index.css` before inventing new keyframes.
- Idle Hub table, sidebar, settings, and lingering skeletons stay static or one-shot enter/exit only.

**Ship order**

1. Short Codr-Hub motion note (allow / deny, agent-task budget) so agents do not invent ambient loops.
2. Hub running / autopilot-in-flight indicators with the same visibility-gated shine as chat live tools. One indicator per active job, not per cell. `apps/web/src/components/hub/HubProjectsTable.tsx`
3. Stronger chat live-row stage cues (enter, complete, fail) without idle loops. `apps/web/src/components/chat/MessagesTimeline.tsx`
4. Optional demo-only HTML walkthroughs (clone skill style) for Hub onboarding. Never wired into the live app runtime.

Steps 1–3 shipped: [docs/codr-hub/MOTION.md](docs/codr-hub/MOTION.md), the Hub row running badge, and `useLiveStageCueRef` enter/complete/fail cues on chat live rows. Owner check by hand on a high-refresh display is pending.

Done when agent work feels alive on chat and Hub, idle surfaces stay still, and reduced-motion / offscreen pauses are verified by hand on a high-refresh display.

## Deferred

- 2026-10-31: Upstream sync kept Codr-Hub names only where the fork had already rebranded a line. Strings upstream added since then (mobile toolbars, outdated-server notice, macOS usage descriptions) still say "T3 Code"; sweep them in one pass rather than per merge. `scripts/build-desktop-artifact.ts:2829`
- 2026-10-28: Desktop auto-update (E8) waits for signed releases. The updater is already built, but `DeaconDP/Codr-Hub` has no releases, `release.yml` is not on `main`, and the repo is private. electron-updater can't read private releases without a baked-in token, and macOS won't apply an update to an unsigned app. To ship it: an Apple Developer ID cert with notarization, Windows signing, a public releases repo set as `T3CODE_DESKTOP_UPDATE_REPOSITORY`, and then flipping `setAutoDownload`/`setAutoInstallOnAppQuit` to true. Source nodes already self-update through the fleet parent. `apps/desktop/src/updates/DesktopUpdates.ts:932`

- 2026-10-27: Mobile OTA updates and EAS are off until Codr-Hub has its own Expo project; the upstream `pingdotgg` owner and project ID were removed. To restore, create the project and set `owner`, `extra.eas.projectId` and `updates.url`. `apps/mobile/app.config.ts:243`
- 2026-10-27: The native mobile "Choose project" screen and the command palette's project list don't show favourites, tags, manual order, or machine colours yet. The web picker model is ready to move into `client-runtime` when they do. `apps/mobile/src/features/threads/NewTaskDraftScreen.tsx`
- 2026-10-27: The picker still starts a thread on the group's preferred checkout; picking a specific machine from its colour icon is not wired. `apps/web/src/components/hub/HubProjectPicker.tsx`
- 2026-10-27: Machine monitor deferred behind site fleet; Ada metrics overlap E5 Fuel Gauge and are host-scoped, not portfolio cards. `ROADMAP.md` E3
- 2026-10-05: Claude banked resets aren't read on macOS because T3 skips the Keychain. Fuel Gauge reads it via `/usr/bin/security`; porting that touches credential handling and needs a security review. `apps/server/src/provider/Layers/claudeResetCredits.ts:153`
- 2026-10-05: Automatic takeover of an offline pacing owner deferred; a timeout could let its paused threads resume alongside a new owner. Recover the owning node and drain it before handover. `apps/server/src/codrHub/quotaOwnership.ts:158`
- 2026-10-05: Native mobile hub screen deferred; the responsive web hub over Tailscale covers mobile for v0.1. `apps/mobile/src/features/`
- 2026-10-05: No disk "scan for checkouts" yet. **Import from T3** and **Sync with T3** fix a missing Deez-PM path when T3 has that project open; for any other project, fix the path by hand. `apps/server/src/codrHub/t3Import.ts`
- 2026-10-05: The Hub has no command palette entry or keybinding yet. Each would be another upstream seam, so they wait until the page settles. `apps/web/src/components/CommandPalette.tsx`
- 2026-10-05: No orchestrator MCP tools for the hub yet (agents can't read or rank the portfolio). `apps/server/src/mcp/`
- 2026-10-05: Autopilot launches one thread per project at a time and does not continue a thread across stages; stage advancement is manual. `apps/server/src/codrHub/selection.ts:30`
- 2026-10-05: Ambient / decorative Hub and settings motion deferred. Continuous animation budget is reserved for live agent tasks (E9). `apps/web/src/components/hub/HubPage.tsx`
- 2026-10-05: Framer Motion / layout animation in product UI deferred. Prefer CSS + `observeVisibleAnimation`. `apps/web/src/lib/visibleAnimation.ts`
- 2026-10-10: E9 step 4 (demo-only HTML Hub onboarding walkthroughs) deferred. It is optional, and the "clone skill style" it should follow isn't documented in the repo yet. `docs/codr-hub/MOTION.md`

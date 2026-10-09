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

### E3. Fold in Deez-Project-Manager

Kanban tasks per project, the machine monitor, Unity Hub/VCC imports, site fleet (preview/live URLs, launch commands), tags and saved views.

### E4. Fold in Cursor-Hub

Wake-on-LAN through an awake LAN peer, git self-update with fan-out to every node, a Tauri-style tray and autostart (T3 desktop already has some of this), and a Cursor IDE transcript mirror.

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

- 2026-10-05: Claude banked resets aren't read on macOS because T3 skips the Keychain. Fuel Gauge reads it via `/usr/bin/security`; porting that touches credential handling and needs a security review. `apps/server/src/provider/Layers/claudeResetCredits.ts:153`
- 2026-10-05: Automatic takeover of an offline pacing owner deferred; a timeout could let its paused threads resume alongside a new owner. Recover the owning node and drain it before handover. `apps/server/src/codrHub/quotaOwnership.ts:158`
- 2026-10-05: Native mobile hub screen deferred; the responsive web hub over Tailscale covers mobile for v0.1. `apps/mobile/src/features/`
- 2026-10-05: No "scan for checkouts" yet. Imported Deez-PM paths point at the old `~/Desktop/Projects` layout and show as missing; fix them by hand per project for now. `apps/server/src/codrHub/deezImport.ts:66`
- 2026-10-05: The Hub has no command palette entry or keybinding yet. Each would be another upstream seam, so they wait until the page settles. `apps/web/src/components/CommandPalette.tsx`
- 2026-10-05: No orchestrator MCP tools for the hub yet (agents can't read or rank the portfolio). `apps/server/src/mcp/`
- 2026-10-05: Autopilot launches one thread per project at a time and does not continue a thread across stages; stage advancement is manual. `apps/server/src/codrHub/selection.ts:30`
- 2026-10-05: Ambient / decorative Hub and settings motion deferred. Continuous animation budget is reserved for live agent tasks (E9). `apps/web/src/components/hub/HubPage.tsx`
- 2026-10-05: Framer Motion / layout animation in product UI deferred. Prefer CSS + `observeVisibleAnimation`. `apps/web/src/lib/visibleAnimation.ts`
- 2026-10-10: E9 step 4 (demo-only HTML Hub onboarding walkthroughs) deferred. It is optional, and the "clone skill style" it should follow isn't documented in the repo yet. `docs/codr-hub/MOTION.md`

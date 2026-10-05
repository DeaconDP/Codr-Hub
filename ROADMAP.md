# Codr-Hub roadmap

Epics and deferred work. Active tasks are in [TODO.md](TODO.md). Brief: [docs/codr-hub/BRIEF.md](docs/codr-hub/BRIEF.md).

## Epics

### E1. v0.1 Portfolio + Autopilot (in progress)

Portfolio store (git-backed), strategy list, project table, Deez-PM import, pacing, autopilot, hub page on web/mobile-web. Done when every point of "v0.1 done means" in the brief passes human testing.

### E2. Mesh hardening

- Push and pull the portfolio repo to a private GitHub remote from every node.
- Coordinate quota across nodes, so that two nodes sharing an account don't both pace it.
- Hub view across environments: a project table that merges data from every connected node.

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

## Deferred

- 2026-10-05: Claude banked resets aren't read on macOS because T3 skips the Keychain. Fuel Gauge reads it via `/usr/bin/security`; porting that touches credential handling and needs a security review. `apps/server/src/provider/Layers/claudeResetCredits.ts:153`
- 2026-10-05: No quota coordination across nodes in v0.1. Rule: enable the autopilot on one node per account. `docs/codr-hub/ARCHITECTURE.md` (Mesh)
- 2026-10-05: Native mobile hub screen deferred; the responsive web hub over Tailscale covers mobile for v0.1. `apps/mobile/src/features/`
- 2026-10-05: No "scan for checkouts" yet. Imported Deez-PM paths point at the old `~/Desktop/Projects` layout and show as missing; fix them by hand per project for now. `apps/server/src/codrHub/deezImport.ts:66`
- 2026-10-05: The Hub has no command palette entry or keybinding yet. Each would be another upstream seam, so they wait until the page settles. `apps/web/src/components/CommandPalette.tsx`
- 2026-10-05: No orchestrator MCP tools for the hub yet (agents can't read or rank the portfolio). `apps/server/src/mcp/`
- 2026-10-05: Autopilot launches one thread per project at a time and does not continue a thread across stages; stage advancement is manual. `apps/server/src/codrHub/selection.ts:30`

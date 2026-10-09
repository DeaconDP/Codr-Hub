# Codr-Hub brief

Codr-Hub is a soft fork of [T3 Code](https://github.com/pingdotgg/t3code). It adds a portfolio layer (projects, strategy, SDLC stage) and an autopilot that spends subscription quota on the projects that matter most, under the owner's chosen level of autonomy.

Supplementary, evolving notes live in Notion ("Codr-Hub" under Development). This file is the source of truth for agents.

## Problem

The owner runs many projects across several machines (a Tailscale mesh of Mac, Windows, Linux, and phone) and several AI subscriptions. The pieces do not connect:

- Strategy lives in Notion, the project list in Deez-Project-Manager, usage in Deez-Fuel-Gauge, and agents in Cursor-Hub, T3 Code, or bare CLIs.
- Nothing ties "what matters most" to "what agents are doing now".
- Subscription quota resets unused while the backlog waits.

## Solution

T3 Code already provides multi-provider agents on subscription (OAuth CLI) logins, Tailscale and multi-environment access, mobile clients, usage-limit tracking, banked resets, git worktrees, PRs, and scheduled tasks. Codr-Hub adds three things on top:

1. **Portfolio**: one table of projects with priority, status, SDLC stage, strategy link, git status, and the hosts each project lives on. It is stored as files in a private git repo, so every mesh node shares it.
2. **Strategy**: an ordered list of specific priorities, such as "Ship Emily-OS v1". Projects link to a priority, and the order of the list drives what the autopilot works on first.
3. **Autopilot**: paces agent work so that each subscription is about 95% spent by its reset, speeding up as the reset approaches. It takes banked resets into account, and the owner can deploy them at will.

## Decisions (grill session, 2026-10-05)

| #               | Decision                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fork            | Soft fork. Keep T3's benefits and merge upstream regularly. Codr-Hub code lives in its own modules behind a small set of hook points ([ARCHITECTURE.md](ARCHITECTURE.md#fork-seams)).            |
| Audience        | The owner for now; possibly other coders later. Nothing may assume a single user's paths or accounts.                                                                                            |
| Billing         | Subscription/OAuth CLI logins, never API keys. API usage is billed separately. This is T3's default, so keep it that way.                                                                        |
| Source of truth | A private git repo holds the portfolio. Notion is supplementary. Deez-PM's `projects.json` is a one-time import.                                                                                 |
| Old apps        | Cursor-Hub, Deez-Project-Manager, and Deez-Fuel-Gauge run in parallel at first, then get archived once Codr-Hub covers them.                                                                     |
| Autonomy        | Set per project, on a spectrum from 0% (off) to 100% (full auto). Strict owners get control and hands-off owners get full automation. A review budget caps how much unreviewed work can pile up. |
| Pacing          | Spend up to 95% of each window before its reset, accelerating near the reset. Count banked resets, and let the owner deploy them manually at any time.                                           |
| SDLC            | Three stages by default (Plan & Design → Dev & Test → Maintain & Improve). A six-stage mode (Plan → Design → Develop → Test → Release → Maintain) is optional.                                   |
| Strategy        | A specific, ordered priority list. Broad themes such as STEP are too high level to show in the app.                                                                                              |
| Hosts           | Every Tailscale mesh node, reachable from mobile. Steve (this MacBook Pro) is the first node.                                                                                                    |
| Docs            | In-repo docs for agents come first: `docs/codr-hub/`, `ROADMAP.md`, and `TODO.md`.                                                                                                               |

## v0.1 done means

From the phone, over Tailscale, the owner can:

1. See every project, imported from Deez-PM, ranked by strategy and priority, with stage, status, git state, and host.
2. Edit a project's priority, status, stage, strategy link, and autonomy level, and have the change land in the portfolio git repo.
3. See each subscription's pace (used vs target, time to reset, banked resets) and deploy a banked reset.
4. Turn the autopilot on and watch it launch stage-appropriate agent threads on the top-ranked eligible project. It must respect the project's autonomy level and review budget.

Folding in the other apps' remaining strengths is the follow-on goal (see [ROADMAP.md](../../ROADMAP.md)).

## Non-goals for v0.1

- Quota coordination was outside v0.1; E2 now assigns one pacing owner through the shared portfolio remote. See [Mesh](ARCHITECTURE.md#mesh) for its boundaries.
- A native mobile screen. The responsive web app over Tailscale covers mobile first.
- A machine monitor, Unity/VCC imports, or a site fleet. These stay in Deez-PM until later.

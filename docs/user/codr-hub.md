# Codr-Hub

Codr-Hub adds a **Hub** page (sidebar → Hub) that ranks your projects, shows how much of each subscription you have used against a spend target, and can run agents on your top projects automatically.

## Getting started

1. Open **Hub** from the sidebar.
2. Set **This node's name** in Hub settings, for example `Steve`. Each machine keeps its own checkout paths under its name.
3. With no projects yet, click **Import** to bring in your existing list, or **Add project** to add one by hand. Imported projects start at **Off**.
4. Tap a project to set its checkout, autonomy, strategy, priority, status, and stage. The list is ranked. A row names the project and, underneath, only what is worth noticing: an autonomy other than **Off**, a status other than **Active**, the strategy it serves (or a stage once it has left the first one), and the checkout on the machine selected at the top. **Path missing** or **No checkout** means the autopilot cannot work on it from that machine. **Finished** shows done and archived projects. Autopilot eligibility is only the environment you pick in the header.

Under a project's **Details**, set **Job kind** to Dev, Edit, Writing, or Image. This chooses the preferred agent and model: Claude for Dev, Cursor for Edit, and Codex for Writing and Image. Coding work can fall back to Codex when its allowance resets first and remains below its target. If no suitable model is available, the project waits.

**Lane** groups projects into Immersion, Automation, or Publicity for filtering. Strategy and priority still determine their rank.

## Project board

Open **Board** on a project row (or `/hub/projects/<id>/board`) for that project's Todo / In progress / Ready for testing / Done cards. Import from Deez-PM also brings cards across, mapping its five columns onto these four. Ready-for-testing cards are planning notes; they are separate from **Needs you** test handoffs. Narrow screens show one column at a time.

## Ranking

Projects are ranked by **Strategy** first, then priority, then favourites. Add priorities in the Strategy list, most important first, and link a project to one from the project page.

## Autonomy

Each project's autonomy limits what the autopilot may do there:

| Autonomy   | What the agent may do                                            |
| ---------- | ---------------------------------------------------------------- |
| Off        | Nothing. The autopilot skips the project.                        |
| Plan       | Propose a plan only. No file changes.                            |
| Supervised | Edit in a separate worktree. You approve each tool call.         |
| Draft PR   | Edit, test, commit, and open a draft pull request. Never merges. |
| Full auto  | All of the above, and merge when tests pass.                     |

**Review budget** caps how many autopilot threads may wait for you on one project. Settling or archiving a thread frees a slot.

## Trying completed work

A finished **Dev & Test** run (three stages) or **Test** run (six stages) puts the project in **Needs you**. Try the result, then choose **Ship** to record acceptance or **Fix** to leave a note about what should change. Ship clears the test gate; merging and publishing remain separate actions.

While a project waits for your verdict, both Autopilot and Run once skip it. Settling or archiving the thread leaves this test gate in place. A Fix note makes the next eligible run an Edit job and is included in its instructions. Review budget, subscription ownership, and the project's autonomy still apply.

## Pace and the autopilot

Subscription pace compares each provider's usage with a target that rises faster near the reset. Set separate spend percentages for **Claude**, **Cursor**, and **OpenAI** in Hub settings; **Other providers (%)** covers the remaining providers. All default to 95%. A provider that is **Behind pace** wants more runs. A provider that reaches its target is **Capped** until its window resets.

- **Autopilot** (top right) checks every minute and launches threads on the highest-ranked eligible projects while a provider is behind pace.
- **Run once** launches one thread now, even if everything is on pace.
- **Deploy reset** redeems a banked reset after you confirm. Automatic deployment is off unless you enable it in Hub settings, and even then it only fires when a reset would otherwise expire unused.

Only subscription logins are paced. Accounts on API keys report no windows and are never used by the autopilot.

Machines using the same portfolio remote automatically choose **one pacing owner per subscription**. The other machines wait and show the owner's name. Run once and automatic reset deployment respect ownership too. Shared pacing needs the provider to report an authenticated account email; if identity or remote access cannot be verified, launches pause.

To hand over, turn Autopilot off on the owning machine, let its runs finish, and settle or archive the threads. Ownership releases on the next minute check. Another machine can then take over. Restarting or disconnecting the owner keeps ownership there; recover that machine to hand over.

## Sharing across machines

The portfolio is a git repository. Set **Portfolio git remote** to a private repository and click **Save & sync** on each machine. After that, each machine syncs every five minutes. Sync retries automatically when another machine pushes first. If edits conflict, sync preserves the local commits and reports the portfolio path. Reconcile the edits there, then click **Save & sync** again. Commit any uncommitted edits and finish any manual merge or rebase before syncing.

Use the same remote and an updated Codr-Hub version on every machine sharing an account. Without a remote, pacing is local: keep Autopilot on one machine per account. Ownership covers Hub's launches and automatic resets; agents and resets you start manually still use the same allowance. To change the remote, turn Autopilot off and finish reviewing its threads first.

Open Codr-Hub on a machine signed into your Tailscale account. The app signs you in. Other Codr-Hub machines on that account show up while the app is open. There is no pairing link to paste. Pairing remains when Tailscale is logged out. A machine that is off or not running Codr-Hub stays absent. Leave Tailscale Funnel off.

The project list merges live data from every connected T3 environment. Pace, Autopilot, Run once, and Import still apply to the environment selected at the top. One unreachable environment is omitted from the merge; it does not hide the others.

## Fleet updates

On a machine with fleet updates enabled, Hub reports when an update is waiting, installing, or stuck. Updates wait for agent turns, approval waits, and background work to finish. If the server stops reporting activity, the update keeps waiting.

Uncommitted work, local commits ahead of upstream, or a diverged branch prevent automatic updates. Resolve the reported checkout issue before updates can continue. Each machine updates its own Codr-Hub checkout.

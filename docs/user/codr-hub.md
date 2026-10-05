# Codr-Hub

Codr-Hub adds a **Hub** page (sidebar → Hub) that ranks your projects, shows how much of each subscription you have used against a spend target, and can run agents on your top projects automatically.

## Getting started

1. Open **Hub** from the sidebar.
2. Set **This node's name** in Hub settings, for example `Steve`. Each machine keeps its own checkout paths under its name.
3. Click **Import from Deez-PM** to bring in your existing project list, or **Add project** to add one by hand. Imported projects start with autonomy **Off**.
4. Check each project's checkout path (click its name). Rows that say **Path missing** cannot be worked on from this machine.

## Ranking

Projects are ranked by **Strategy** first, then priority, then favourites. Add your strategic priorities in the Strategy panel, most important first, and link projects to them from the table.

## Autonomy

Each project's autonomy limits what the autopilot may do there:

| Autonomy       | What the agent may do                                            |
| -------------- | ---------------------------------------------------------------- |
| Off            | Nothing. The autopilot skips the project.                        |
| 25% Plan       | Propose a plan only. No file changes.                            |
| 50% Supervised | Edit in a separate worktree. You approve each tool call.         |
| 75% Draft PR   | Edit, test, commit, and open a draft pull request. Never merges. |
| 100% Full auto | All of the above, and merge when tests pass.                     |

**Review budget** caps how many autopilot threads may wait for you on one project. Settling or archiving a thread frees a slot.

## Pace and the autopilot

Subscription pace compares each provider's usage with a target that reaches **Spend target before reset** (95% by default) at the reset, rising faster near the end. A provider that is **Behind pace** wants more runs. A provider that reaches the target is **Capped** until its window resets.

- **Autopilot** (top right) checks every minute and launches threads on the highest-ranked eligible projects while a provider is behind pace.
- **Run once** launches one thread now, even if everything is on pace.
- **Deploy reset** redeems a banked reset after you confirm. Automatic deployment is off unless you enable it in Hub settings, and even then it only fires when a reset would otherwise expire unused.

Only subscription logins are paced. Accounts on API keys report no windows and are never used by the autopilot.

Enable the autopilot on **one machine per account**. Machines do not yet coordinate quota with each other.

## Sharing across machines

The portfolio is a git repository. Set **Portfolio git remote** to a private repository and click **Save & sync** on each machine. After that, each machine syncs every five minutes. If two machines change the same project at once, sync stops and reports the conflict instead of guessing.

# Codr-Hub fleet supervisor

The fleet parent keeps one source checkout running and fast-forwards it when its upstream changes. It waits for agent turns, approvals, and background work to finish before stopping the server. This is separate from the installed T3 server service.

## Start and enable at login

Use Node 24 and install the checkout's dependencies with `vp i`. Stop any development server using the chosen data directory through its original launcher after its work finishes. The parent only manages processes it started.

From the checkout root, run the parent in the foreground:

```sh
node scripts/codr-hub-fleet/parent.ts --run
```

Its default home is `<checkout>/.t3`. The parent and server use `<home>/userdata`, with fleet reports, activity, process records, and `fleet.log` under `codr-hub/`. An inherited `T3CODE_HOME` does not select another server's database. Keep this development home separate from the installed server's home.

Dev-runner selects the web and server ports, including worktree offsets and shifts around occupied ports. Read its startup line in `fleet.log` for the web URL. The parent reads the server's actual port from `userdata/server-runtime.json`.

To select another development home or pin the backend port:

```sh
node scripts/codr-hub-fleet/parent.ts --run --home-dir /path/to/fleet-data --port 15123
```

Relative home paths resolve from the checkout root. The web port remains dev-runner's choice. Stop the foreground parent with Ctrl+C, then enable login startup with the same options:

```sh
node scripts/codr-hub-fleet/parent.ts --arm --home-dir /path/to/fleet-data --port 15123
```

Omit `--home-dir` and `--port` for the defaults. The login entry saves the resolved home and any explicit port. macOS uses launchd, Linux uses a systemd user service, and Windows uses a logon task. macOS and Linux start it immediately; Windows starts it at the next logon. Enabling login startup does not migrate existing data from another home.

## Resolve a blocked update

Hub reports the reason when an update waits or gets stuck. A dirty, ahead, or diverged checkout stays unchanged. Resolve that Git state yourself. A server with no fresh activity report stays running until reporting recovers or it exits. If an untracked server uses the same data directory, stop it through its original launcher before letting the parent start its replacement.

Each node needs its own login entry and upstream-tracking branch. Only fast-forwards are automatic; the parent never pushes commits.

## Remove login startup

```sh
node scripts/codr-hub-fleet/parent.ts --disarm
```

This removes the login entry. The detached development server remains running. Stop it separately after its work finishes if it should also shut down.

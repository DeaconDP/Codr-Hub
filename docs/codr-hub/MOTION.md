# Codr-Hub motion

Motion is for live agent work. Idle UI stays still. Read this before adding any animation to Codr-Hub surfaces.

## Allowed

- **Continuous loops on live agent work only:** a running turn, tool, thinking, compacting, worktree setup, browser session, or Hub autopilot job. The loop stops the moment that work ends.
- **One loop per active job.** In the Hub, the project row's "running" badge is the job's indicator. Do not also animate the host lines, the pace panel, or other cells for the same job.
- **One-shot stage cues** on live rows: enter, complete, and fail. Each is a single short animation (under 300 ms) that plays only when the state changes during the row's lifetime. A remounted row that is already done does not replay its cue.
- **Enter and exit transitions** on dialogs, menus, and toasts that already have them.

## Not allowed

- Ambient or decorative loops on idle chrome: the Hub table, sidebar, settings, strategy and pace panels, and skeletons that linger.
- Animating layout properties (`width`, `height`, `top`, `left`, `margin`, `padding`). Animate `transform`, `opacity`, or clipped text gradients (`background-position` under `background-clip: text`) only.
- Framer Motion or other motion libraries in product UI.
- New keyframes when an existing one fits.

## How

- **Loops:** reuse `live-tool-shine` (text sweep) or `live-activity-focus` (masked highlight) from `apps/web/src/index.css`. Attach `observeVisibleAnimation` (`apps/web/src/lib/visibleAnimation.ts`) to the animated element or a stable container. It pauses the loop when the element is offscreen, the tab is hidden, or `prefers-reduced-motion` is set. Pass the ref only while the work is live, so idle rows never register.
- **Stage cues:** `useLiveStageCueRef` (`apps/web/src/codrHub/liveStageCue.ts`) plays enter, complete, and fail cues with the Web Animations API. It skips cues under reduced motion or a hidden tab, and also wires `observeVisibleAnimation` while the row is live.
- **Budget:** at most one continuous loop per live job on screen, plus one-shot cues. If a new surface needs more, add it to the [roadmap](../../ROADMAP.md) first.

## Checking by hand

On a high-refresh display:

1. Start a turn and confirm the live tool row shines, then settles with a single cue when it finishes or fails.
2. Scroll the live row offscreen or switch tabs. The loop pauses (Performance panel: no style recalcs).
3. Turn on Reduce motion in the OS. No loops and no cues play; text stays readable.
4. Run an autopilot job. Only that project's row badge animates; the rest of the Hub stays still.

import { observeVisibleAnimation } from "../../lib/visibleAnimation";

/**
 * The one live indicator for a project's autopilot work (docs/codr-hub/MOTION.md).
 * Mounted only while a job runs; the shine pauses offscreen, in hidden tabs,
 * and under reduced motion.
 */
export function HubRunningBadge({ count }: { count: number }) {
  return (
    <span ref={observeVisibleAnimation} className="live-tool-shine text-sm text-foreground">
      {count > 1 ? `${count} running` : "running"}
    </span>
  );
}

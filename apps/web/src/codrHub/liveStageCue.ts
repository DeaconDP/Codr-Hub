import { useCallback, useLayoutEffect, useRef } from "react";

import { observeVisibleAnimation } from "~/lib/visibleAnimation";

/**
 * Codr-Hub E9: one-shot stage cues for live agent rows. See docs/codr-hub/MOTION.md.
 * Cues animate transform/opacity only and never loop.
 */
export type LiveStage = { readonly active: boolean; readonly failed: boolean };
export type LiveStageCue = "enter" | "complete" | "fail";

/** Which cue a state change earns. `previous` is null on the row's first render. */
export function liveStageCue(previous: LiveStage | null, next: LiveStage): LiveStageCue | null {
  if (previous === null) return next.active && !next.failed ? "enter" : null;
  if (!previous.failed && next.failed) return "fail";
  if (previous.active && !next.active && !next.failed) return "complete";
  return null;
}

const CUE_KEYFRAMES: Record<LiveStageCue, Keyframe[]> = {
  enter: [
    { opacity: 0, transform: "translateY(3px)" },
    { opacity: 1, transform: "translateY(0)" },
  ],
  complete: [{ opacity: 1 }, { opacity: 0.45 }, { opacity: 1 }],
  fail: [
    { transform: "translateX(0)" },
    { transform: "translateX(-3px)" },
    { transform: "translateX(3px)" },
    { transform: "translateX(-2px)" },
    { transform: "translateX(0)" },
  ],
};

const CUE_TIMING: Record<LiveStageCue, KeyframeAnimationOptions> = {
  enter: { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" },
  complete: { duration: 260, easing: "ease-out" },
  fail: { duration: 280, easing: "ease-in-out" },
};

function motionAllowed() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  if (document.visibilityState !== "visible") return false;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function playLiveStageCue(element: Element, cue: LiveStageCue) {
  if (!element.isConnected || typeof element.animate !== "function" || !motionAllowed()) return;
  element.animate(CUE_KEYFRAMES[cue], CUE_TIMING[cue]);
}

/**
 * Callback ref for a live row: plays stage cues on state changes and, while
 * the row is live, gates its CSS loops with `observeVisibleAnimation`.
 */
export function useLiveStageCueRef<T extends HTMLElement>(active: boolean, failed: boolean) {
  const elementRef = useRef<T | null>(null);
  const previousRef = useRef<LiveStage | null>(null);
  const live = active && !failed;

  useLayoutEffect(() => {
    const next = { active, failed };
    const cue = liveStageCue(previousRef.current, next);
    previousRef.current = next;
    if (cue !== null && elementRef.current !== null) playLiveStageCue(elementRef.current, cue);
  }, [active, failed]);

  return useCallback(
    (element: T | null) => {
      elementRef.current = element;
      if (element === null || !live) return undefined;
      const stop = observeVisibleAnimation(element);
      return () => {
        stop?.();
        if (elementRef.current === element) elementRef.current = null;
      };
    },
    [live],
  );
}

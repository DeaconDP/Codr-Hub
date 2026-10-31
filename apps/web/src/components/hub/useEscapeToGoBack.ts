import { useCanGoBack, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * Escape returns to the previous app page, or home without app history. Controls that
 * handle Escape themselves call `preventDefault`, so this only fires when nothing else did.
 */
export function useEscapeToGoBack() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds a window keydown listener while the page is mounted.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.key !== "Escape")
        return;
      event.preventDefault();
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) activeElement.blur();
      if (canGoBack) {
        window.history.back();
        return;
      }
      void navigate({ to: "/" });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canGoBack, navigate]);
}

import { useEffect, useRef } from "react";

/** Run background work less often in hidden tabs and immediately refresh on return. */
export function useVisibilityPoll(
  callback: () => void,
  visibleInterval: number,
  hiddenInterval = Math.max(visibleInterval * 6, 60_000),
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;

    const schedule = () => {
      if (!active) return;
      const interval = document.visibilityState === "hidden" ? hiddenInterval : visibleInterval;
      timer = setTimeout(() => {
        callbackRef.current();
        schedule();
      }, interval);
    };
    const refresh = () => {
      if (document.visibilityState === "visible") callbackRef.current();
      if (timer) clearTimeout(timer);
      schedule();
    };

    schedule();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [hiddenInterval, visibleInterval]);
}

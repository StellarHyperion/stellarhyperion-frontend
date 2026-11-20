import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createVisibilityPollBudget, type PollWork } from "./visibility-poll-budget";

/** Run background work less often in hidden tabs and immediately refresh on return. */
export function useVisibilityPoll(
  callback: PollWork,
  visibleInterval: number,
  hiddenInterval = Math.max(visibleInterval * 6, 60_000),
  scope = "",
  initialDelay?: number,
) {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    const budget = createVisibilityPollBudget({
      callback: (signal) => callbackRef.current(signal),
      visible: () => document.visibilityState === "visible",
      visibleInterval,
      hiddenInterval,
      onRefreshing: setRefreshing,
      ...(initialDelay === undefined ? {} : { initialDelay }),
    });
    document.addEventListener("visibilitychange", budget.visibilityChanged);
    return () => {
      budget.stop();
      document.removeEventListener("visibilitychange", budget.visibilityChanged);
    };
  }, [hiddenInterval, visibleInterval, scope, initialDelay]);
  return refreshing;
}

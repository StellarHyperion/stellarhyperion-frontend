export type PollWork = (signal: AbortSignal) => void | Promise<void>;

/** Owns one timer and one request. Visibility refreshes cannot stack background loops. */
export function createVisibilityPollBudget({
  callback,
  visible,
  visibleInterval,
  hiddenInterval,
  initialDelay,
  onRefreshing = () => undefined,
}: {
  callback: PollWork;
  visible: () => boolean;
  visibleInterval: number;
  hiddenInterval: number;
  initialDelay?: number;
  onRefreshing?: (refreshing: boolean) => void;
}) {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  let refreshQueued = false;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    clear();
    if (active) timer = setTimeout(() => void run(), visible() ? visibleInterval : hiddenInterval);
  };
  const run = async () => {
    if (!active) return;
    clear();
    if (controller !== null) {
      refreshQueued = true;
      controller.abort();
      return;
    }
    const current = new AbortController();
    controller = current;
    onRefreshing(true);
    try {
      await callback(current.signal);
    } catch {
      // Callers retain their domain-specific error state; failed refreshes still have a budget.
    } finally {
      controller = null;
      if (!active) return;
      if (refreshQueued && visible()) {
        refreshQueued = false;
        void run();
      } else {
        refreshQueued = false;
        onRefreshing(false);
        schedule();
      }
    }
  };
  if (initialDelay === undefined) schedule();
  else timer = setTimeout(() => void run(), visible() ? Math.max(0, initialDelay) : hiddenInterval);
  return {
    refresh: run,
    visibilityChanged() {
      clear();
      if (visible()) {
        onRefreshing(true);
        void run();
      } else {
        refreshQueued = false;
        controller?.abort();
        if (!controller) schedule();
      }
    },
    stop() {
      active = false;
      clear();
      controller?.abort();
    },
  };
}

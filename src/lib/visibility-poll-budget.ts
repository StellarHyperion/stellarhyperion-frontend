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
  const state = { active: true, refreshQueued: false };
  const isActive = () => state.active;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    clear();
    if (state.active)
      timer = setTimeout(() => void run(), visible() ? visibleInterval : hiddenInterval);
  };
  const run = async () => {
    if (!isActive()) return;
    clear();
    if (controller !== null) {
      state.refreshQueued = true;
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
      if (!isActive()) return;
      if (state.refreshQueued && visible()) {
        state.refreshQueued = false;
        void run();
      } else {
        state.refreshQueued = false;
        onRefreshing(false);
        schedule();
      }
    }
  };
  if (initialDelay === undefined) schedule();
  else timer = setTimeout(() => void run(), visible() ? Math.max(0, initialDelay) : hiddenInterval);
  return {
    refresh: run,
    visibilityChanged: () => {
      clear();
      if (visible()) {
        onRefreshing(true);
        void run();
      } else {
        state.refreshQueued = false;
        controller?.abort();
        if (!controller) schedule();
      }
    },
    stop() {
      state.active = false;
      clear();
      controller?.abort();
    },
  };
}

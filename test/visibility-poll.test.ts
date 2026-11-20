import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVisibilityPollBudget } from "../src/lib/visibility-poll-budget";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("visibility-aware polling ownership", () => {
  it("reduces hidden work, immediately refreshes on return, and keeps one timer", async () => {
    let visible = true;
    const work = vi.fn(() => Promise.resolve());
    const budget = createVisibilityPollBudget({
      callback: work,
      visible: () => visible,
      visibleInterval: 1000,
      hiddenInterval: 60000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(work).toHaveBeenCalledTimes(1);
    visible = false;
    budget.visibilityChanged();
    await vi.advanceTimersByTimeAsync(59999);
    expect(work).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(work).toHaveBeenCalledTimes(2);
    visible = true;
    budget.visibilityChanged();
    await Promise.resolve();
    expect(work).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    budget.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts an old lookup and waits for it before one queued foreground refresh", async () => {
    let visible = true;
    let finish!: () => void;
    const signals: AbortSignal[] = [];
    const refreshed: boolean[] = [];
    const work = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const budget = createVisibilityPollBudget({
      callback: work,
      visible: () => visible,
      visibleInterval: 1000,
      hiddenInterval: 60000,
      initialDelay: 0,
      onRefreshing: (value) => refreshed.push(value),
    });
    await vi.advanceTimersByTimeAsync(0);
    visible = false;
    budget.visibilityChanged();
    expect(signals[0].aborted).toBe(true);
    visible = true;
    budget.visibilityChanged();
    budget.visibilityChanged();
    await vi.advanceTimersByTimeAsync(120000);
    expect(work).toHaveBeenCalledTimes(1);
    expect(refreshed.at(-1)).toBe(true);
    finish();
    await Promise.resolve();
    expect(work).toHaveBeenCalledTimes(2);
    expect(signals[1].aborted).toBe(false);
    finish();
    await Promise.resolve();
    expect(refreshed.at(-1)).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    budget.stop();
  });

  it("does not revive a stopped scope after a late response or rejected callback", async () => {
    let finish!: () => void;
    const work = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const budget = createVisibilityPollBudget({
      callback: work,
      visible: () => true,
      visibleInterval: 1000,
      hiddenInterval: 60000,
      initialDelay: 0,
    });
    await vi.advanceTimersByTimeAsync(0);
    budget.stop();
    finish();
    await vi.advanceTimersByTimeAsync(120000);
    expect(work).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    const failed = createVisibilityPollBudget({
      callback: () => Promise.reject(new Error("offline")),
      visible: () => true,
      visibleInterval: 1000,
      hiddenInterval: 60000,
      initialDelay: 0,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    failed.stop();
  });
});

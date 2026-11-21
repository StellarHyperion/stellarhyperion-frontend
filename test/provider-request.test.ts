import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithDeadline } from "../src/lib/provider-request";

afterEach(() => vi.unstubAllGlobals());

describe("provider request deadlines", () => {
  it("aborts a stalled provider request", async () => {
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(fetchWithDeadline("https://provider.example", {}, 1)).rejects.toThrow();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("propagates an already aborted caller before starting provider work", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(true);
      return Promise.reject(new DOMException("aborted", "AbortError"));
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(
      fetchWithDeadline("https://provider.example", { signal: controller.signal }),
    ).rejects.toThrow("aborted");
  });

  it("passes caller cancellation to the provider", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockRejectedValue(new Error("cancelled"));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      fetchWithDeadline("https://provider.example", { signal: controller.signal }, 1000),
    ).rejects.toThrow("cancelled");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

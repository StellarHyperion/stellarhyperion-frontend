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

  it("keeps the deadline active while reading a stalled response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => {
                controller.error(new DOMException("body aborted", "AbortError"));
              },
              { once: true },
            );
          },
        });
        return Promise.resolve(new Response(body));
      }),
    );
    const response = await fetchWithDeadline("https://provider.example", {}, 10);
    await expect(response.text()).rejects.toThrow("body aborted");
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

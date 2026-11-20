import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFeeRequestGuard,
  FEE_MAX_REQUESTS,
  FEE_MAX_RESPONSE_BYTES,
  readFeeResponse,
  validateFeeRequest,
} from "../src/lib/fee-request-guard";

afterEach(() => vi.unstubAllGlobals());

describe("bounded public provider admission", () => {
  it("caps concurrent provider requests and releases an admission exactly once", () => {
    const guard = createFeeRequestGuard(() => 0);
    const active = Array.from({ length: 4 }, () => guard.acquire());
    expect(guard.acquire()).toEqual({ retryAfter: 1 });
    const first = active[0];
    if (!("release" in first)) throw new Error("Missing admission");
    first.release();
    first.release();
    expect(guard.acquire()).toHaveProperty("release");
    expect(guard.acquire()).toEqual({ retryAfter: 1 });
  });
  it("retains a bounded minute budget across completed provider calls", () => {
    let now = 0;
    const guard = createFeeRequestGuard(() => now);
    for (let i = 0; i < FEE_MAX_REQUESTS; i++) {
      const admission = guard.acquire();
      if (!("release" in admission)) throw new Error("Budget unexpectedly exhausted");
      admission.release();
    }
    expect(guard.acquire()).toEqual({ retryAfter: 60 });
    now = 59999;
    expect(guard.acquire()).toEqual({ retryAfter: 1 });
    now = 60000;
    expect(guard.acquire()).toHaveProperty("release");
  });
  it.each([
    "?destination=base-sepolia&destination=sepolia",
    "?provider=https://untrusted.invalid",
    "?destination=" + "a".repeat(2048),
  ])("rejects unbounded or ambiguous provider selection %s", (query) => {
    expect(() =>
      validateFeeRequest(new Request("http://localhost/api/cctp-fee" + query), ["destination"]),
    ).toThrow();
  });
  it("cancels oversized declared or chunked provider responses before parsing", async () => {
    const cancel = vi.fn();
    const declared = new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": String(FEE_MAX_RESPONSE_BYTES + 1) },
    });
    await expect(readFeeResponse(declared)).rejects.toThrow("budget");
    expect(cancel).toHaveBeenCalledTimes(1);
    const chunkCancel = vi.fn();
    const chunked = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(FEE_MAX_RESPONSE_BYTES));
          controller.enqueue(new Uint8Array(1));
        },
        cancel: chunkCancel,
      }),
    );
    await expect(readFeeResponse(chunked)).rejects.toThrow("budget");
    expect(chunkCancel).toHaveBeenCalledTimes(1);
    await expect(readFeeResponse(new Response(new Uint8Array([255])))).rejects.toThrow();
  });
  it("rejects forged forwarding identities while both routes share the provider concurrency budget", async () => {
    vi.resetModules();
    const { GET: relay } = await import("../src/app/api/relay-fee/route");
    const { GET: circle } = await import("../src/app/api/cctp-fee/route");
    const release: ((value: Response) => void)[] = [];
    const provider = vi.fn(() => new Promise<Response>((resolve) => release.push(resolve)));
    vi.stubGlobal("fetch", provider);
    const inflight = Array.from({ length: 4 }, (_, i) =>
      relay(
        new Request("http://localhost/api/relay-fee", {
          headers: { "x-forwarded-for": `198.51.100.${i}` },
        }),
      ),
    );
    expect(provider).toHaveBeenCalledTimes(4);
    const rejected = await circle(
      new Request("http://localhost/api/cctp-fee?destination=base-sepolia", {
        headers: { "x-forwarded-for": "203.0.113.99" },
      }),
    );
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe("1");
    expect(rejected.headers.get("cache-control")).toBe("no-store");
    expect(await rejected.json()).toMatchObject({ code: "RATE_LIMITED", retryAfter: 1 });
    expect(provider).toHaveBeenCalledTimes(4);
    release.forEach((finish) => {
      finish(new Response("1000"));
    });
    expect((await Promise.all(inflight)).every((response) => response.status === 200)).toBe(true);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify([{ finalityThreshold: 2000, minimumFee: 0, forwardFee: { med: 101 } }]),
          ),
        ),
    );
    expect(
      (await circle(new Request("http://localhost/api/cctp-fee?destination=base-sepolia"))).status,
    ).toBe(200);
  });
});

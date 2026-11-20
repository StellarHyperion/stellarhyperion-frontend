import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getRelayFee } from "../src/app/api/relay-fee/route";
import { GET as getCctpFee } from "../src/app/api/cctp-fee/route";
import { createFeeRequestGuard, feeRequestGuard } from "../src/lib/fee-request-guard";

beforeEach(() => {
  const guard = createFeeRequestGuard();
  vi.spyOn(feeRequestGuard, "acquire").mockImplementation(() => guard.acquire());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fee route contracts", () => {
  it("returns exact integer relay budgets from a provider response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('"1000001"')));
    const response = await getRelayFee(new Request("http://localhost/api/relay-fee"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      estimatedAmount: "1000001",
      amount: "1100002",
      decimals: 7,
    });
  });

  it.each([
    ["timeout", vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError"))],
    ["rate limit", vi.fn().mockResolvedValue(new Response("busy", { status: 429 }))],
    ["malformed", vi.fn().mockResolvedValue(new Response("not-an-integer"))],
  ])("keeps %s responses non-executable", async (_name, fetcher) => {
    vi.stubGlobal("fetch", fetcher);
    const response = await getRelayFee(new Request("http://localhost/api/relay-fee"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Relay gas pricing is unavailable. No transfer can be prepared.",
    });
  });

  it.each(["sepolia", "base-sepolia", "arc-testnet"])(
    "validates actual CCTP %s handler budgets without credentials",
    async (destination) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(
              JSON.stringify([{ finalityThreshold: 2000, minimumFee: 0, forwardFee: { med: 12 } }]),
            ),
          ),
      );
      const response = await getCctpFee(
        new Request(`http://localhost/api/cctp-fee?destination=${destination}`),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        estimatedAmount: "120",
        amount: "140",
        token: "USDC",
        destination,
      });
    },
  );

  it.each(["sepolia", "base-sepolia", "arc-testnet"])(
    "keeps every %s provider failure non-executable",
    async (destination) => {
      for (const response of [
        new DOMException("timeout", "TimeoutError"),
        new Response("busy", { status: 429 }),
        new Response("not-json"),
        new Response(
          JSON.stringify([{ finalityThreshold: 2000, minimumFee: 0, forwardFee: { med: 0 } }]),
        ),
        new Response("x".repeat(8193)),
      ]) {
        vi.stubGlobal(
          "fetch",
          response instanceof Error
            ? vi.fn().mockRejectedValue(response)
            : vi.fn().mockResolvedValue(response),
        );
        const result = await getCctpFee(
          new Request(`http://localhost/api/cctp-fee?destination=${destination}`),
        );
        expect(result.status).toBe(503);
        expect(await result.json()).toEqual({
          error: "Circle forwarding pricing is unavailable. Try again later.",
        });
        expect(result.headers.get("Cache-Control")).toBe("no-store");
      }
    },
  );

  it("rejects invalid or duplicate fee parameters before reaching a provider", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const query of [
      "destination=unknown",
      "destination=sepolia&destination=sepolia",
      "destination=sepolia&token=USDC",
    ])
      expect((await getCctpFee(new Request(`http://localhost/api/cctp-fee?${query}`))).status).toBe(
        400,
      );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enforces the process concurrency budget at the actual route boundary", async () => {
    const pending: ((response: Response) => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            pending.push(resolve);
          }),
      ),
    );
    const requests = Array.from({ length: 4 }, () =>
      getRelayFee(new Request("http://localhost/api/relay-fee")),
    );
    const blocked = await getRelayFee(new Request("http://localhost/api/relay-fee"));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("1");
    expect(pending).toHaveLength(4);
    for (const resolve of pending) resolve(new Response('"1000001"'));
    expect((await Promise.all(requests)).map((result) => result.status)).toEqual([
      200, 200, 200, 200,
    ]);
  });
});

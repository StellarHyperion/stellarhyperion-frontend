import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as getRelayFee } from "../src/app/api/relay-fee/route";
import { GET as getCctpFee } from "../src/app/api/cctp-fee/route";

afterEach(() => vi.unstubAllGlobals());

describe("fee route contracts", () => {
  it("returns exact integer relay budgets from a provider response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('"1000001"')));
    const response = await getRelayFee();
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
    const response = await getRelayFee();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Relay gas pricing is unavailable. No transfer can be prepared.",
    });
  });

  it("validates CCTP destination and provider fixtures without credentials", async () => {
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
      new Request("http://localhost/api/cctp-fee?destination=sepolia"),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      estimatedAmount: "120",
      amount: "140",
      token: "USDC",
    });
  });
});

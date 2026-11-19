import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTransferByTx, fetchTransfers, normalizeTransfersResponse } from "../src/api/backend";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("Real indexer client", () => {
  it("does not manufacture records when no indexer is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_HYPERION_API_URL", "");
    vi.stubEnv("NEXT_PUBLIC_HYPERION_INDEXER_URL", "");
    await expect(fetchTransfers()).rejects.toThrow("no indexer is configured");
  });
  it("surfaces network errors rather than silently using samples", async () => {
    vi.stubEnv("NEXT_PUBLIC_HYPERION_API_URL", "https://indexer.example");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(fetchTransfers()).rejects.toThrow("unreachable");
  });
  it("surfaces server errors, including claims failures", async () => {
    vi.stubEnv("NEXT_PUBLIC_HYPERION_API_URL", "https://indexer.example");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 500 })));
    await expect(fetchTransfers()).rejects.toThrow("HTTP 500");
  });
  it("treats a genuine 404 lookup as not found", async () => {
    vi.stubEnv("NEXT_PUBLIC_HYPERION_API_URL", "https://indexer.example");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
    expect(await fetchTransferByTx("missing")).toBeNull();
  });
  it("passes search and pagination to the backend without altering amounts", async () => {
    vi.stubEnv("NEXT_PUBLIC_HYPERION_API_URL", "https://indexer.example/");
    const payload = { transfers: [], count: 0, limit: 20, offset: 40 };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload)));
    vi.stubGlobal("fetch", fetcher);
    expect(await fetchTransfers({ search: "hash & recipient", offset: "40" })).toEqual(payload);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://indexer.example/v1/transfers?search=hash+%26+recipient&offset=40",
    );
  });
  it("renders the supported older data shape without inventing evidence", () => {
    const result = normalizeTransfersResponse({
      data: [
        {
          id: "legacy-1",
          stage: "initiated",
          route: 1,
          origin: {
            chain: "stellar",
            nonce: "7",
            sender: "G...",
            token: "C...",
            grossAmount: "100",
            fee: "1",
            netAmount: "99",
            block: "1",
            txHash: "a".repeat(64),
            observedAt: "2026-01-01T00:00:00Z",
          },
          destination: {
            chain: "sepolia",
            recipient: "0x1111111111111111111111111111111111111111",
            delivered: false,
          },
        },
      ],
    });
    expect(result.transfers).toHaveLength(1);
    expect(result.transfers[0]?.destination.amount).toBeNull();
    expect(result.transfers[0]?.claim).toBeNull();
    expect(result.transfers[0]?.destination.recipient).toBe(
      "0x1111111111111111111111111111111111111111",
    );
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cursorFreshness,
  fetchIndexerMetrics,
  fetchClaims,
  fetchTransferByTx,
  fetchTransfers,
  filterTransfers,
  type FormattedTransfer,
} from "../src/api/backend";
import {
  readTransferFilters,
  validateTransferFilters,
  filterSupportError,
  transferRowIdentity,
} from "../src/lib/transfer-filters";
import { Keypair } from "@stellar/stellar-sdk";
import { getEvidenceTimeline, hasVerifiedDestinationEvidence } from "../src/lib/evidence";
import { formatTokenAmount, formatTokenIdentity } from "../src/lib/format";
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
    expect(await fetchTransferByTx("a".repeat(64))).toBeNull();
  });
  it("rejects invalid hashes before making any indexer request", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const hash of ["", "a".repeat(63), "g".repeat(64), "0x" + "a".repeat(64), "a/b"]) {
      await expect(fetchTransferByTx(hash)).rejects.toThrow("64-character");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("canonicalizes a valid hash while retaining transport failure as unavailable", async () => {
    vi.stubEnv("NEXT_PUBLIC_HYPERION_API_URL", "https://indexer.example");
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(fetchTransferByTx("AB".repeat(32))).rejects.toThrow("HTTP 503");
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://indexer.example/v1/transfers/by-tx/" + "ab".repeat(32),
    );
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
  it("lists claims with explicit chain and settlement filters", async () => {
    vi.stubEnv("NEXT_PUBLIC_HYPERION_API_URL", "https://indexer.example");
    const payload = { claims: [], count: 0, limit: 20, offset: 0 };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload)));
    vi.stubGlobal("fetch", fetcher);
    expect(await fetchClaims({ chain: "stellar-testnet", settled: "false", limit: "20" })).toEqual(
      payload,
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://indexer.example/v1/claims?chain=stellar-testnet&settled=false&limit=20",
    );
  });
  it("preserves optional scoped coverage metadata without inventing it", async () => {
    vi.stubEnv("NEXT_PUBLIC_HYPERION_API_URL", "https://indexer.example");
    const payload = {
      transfers: [],
      count: 0,
      limit: 20,
      offset: 0,
      coverage: {
        complete: false,
        oldestObservedAt: "2026-11-01T00:00:00.000Z",
        reason: "The public RPC retention window starts later.",
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));
    expect((await fetchTransfers()).coverage).toEqual(payload.coverage);
  });

  it("reads indexer cursors for freshness without conflating metrics failure with empty history", async () => {
    vi.stubEnv("NEXT_PUBLIC_HYPERION_API_URL", "https://indexer.example");
    const payload = {
      service: "hyperion-backend",
      network: "testnet",
      uptimeSeconds: 20,
      transfers: { totalOutbound: 0, totalInbound: 0 },
      claims: { total: 0, settled: 0, unsettled: 0 },
      railAttestations: {},
      cursors: [
        {
          chain: "stellar-testnet",
          block: "123",
          hash: null,
          updatedAt: "2026-11-18T12:00:00.000Z",
        },
      ],
    };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload)));
    vi.stubGlobal("fetch", fetcher);
    expect(await fetchIndexerMetrics()).toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith(
      "https://indexer.example/v1/metrics",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(
      cursorFreshness(payload.cursors[0] ?? null, Date.parse("2026-11-18T12:31:00.000Z")),
    ).toBe("stale");
  });
});

describe("transfer evidence", () => {
  it("renders CCTP and ITS exact amounts and keeps unknown precision in base units", () => {
    expect(formatTokenAmount("1234567", 6)).toBe("1.234567");
    expect(formatTokenAmount("1234567", 7)).toBe("0.1234567");
    for (const decimals of [undefined, null, -1, 1.5, NaN, 256]) {
      expect(formatTokenAmount("1234567", decimals)).toBe("1234567 base units");
    }
    expect(formatTokenIdentity("0x1111", "USDC", 6, "native")).not.toEqual(
      formatTokenIdentity("0x2222", "USDC", 7, "ITS"),
    );
  });
  const transfer = (overrides: Partial<FormattedTransfer> = {}): FormattedTransfer => ({
    id: "transfer-1",
    stage: "delivering",
    route: 1,
    origin: {
      chain: "stellar-testnet",
      nonce: "1",
      sender: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      token: "CUSDC",
      symbol: "USDC",
      decimals: 7,
      grossAmount: "10000000",
      fee: "30000",
      netAmount: "9970000",
      block: "123",
      txHash: "source-hash",
      observedAt: "2026-11-18T12:00:00.000Z",
    },
    destination: {
      chain: "sepolia",
      recipient: "0x0000000000000000000000000000000000000001",
      delivered: false,
      block: null,
      txHash: null,
      deliveredAt: null,
    },
    rail: {
      status: "submitted",
      railStatus: "executed",
      reference: "provider-1",
      attestedAt: null,
      lastError: null,
    },
    claim: null,
    ...overrides,
  });

  it("validates shareable exact identities and rejects symbols, duplicates and malformed revisions", () => {
    const issuer = Keypair.random().publicKey();
    expect(
      readTransferFilters("?asset=" + encodeURIComponent("USDC:" + issuer)).filters.asset,
    ).toBe("USDC:" + issuer);
    expect(
      validateTransferFilters({ asset: " 0x" + "A".repeat(40) + " ", deployment: "B".repeat(64) }),
    ).toEqual({
      filters: { asset: "0x" + "a".repeat(40), deployment: "b".repeat(64) },
      error: null,
    });
    for (const query of [
      "?asset=USDC",
      "?asset=USDC%3Abad",
      "?deployment=latest",
      "?asset=&asset=",
      "?deployment=&deployment=",
    ]) {
      expect(readTransferFilters(query).error).not.toBeNull();
    }
  });
  it("separates identical nonces across deployments without changing integer amounts", () => {
    const base = transfer();
    const first = {
      ...base,
      origin: {
        ...base.origin,
        router: "0x" + "A".repeat(40),
        revision: "B".repeat(64),
        token: "0x" + "1".repeat(40),
      },
    };
    const second = {
      ...first,
      origin: { ...first.origin, router: "0x" + "2".repeat(40), revision: "C".repeat(64) },
    };
    const third = { ...first, origin: { ...first.origin, token: "0x" + "3".repeat(40) } };
    expect(transferRowIdentity(first)).not.toBe(transferRowIdentity(second));
    expect(transferRowIdentity(first)).not.toBe(transferRowIdentity(third));
    expect(filterTransfers([first, second], { deployment: "b".repeat(64) })).toEqual([first]);
    expect(filterTransfers([first, third], { asset: "0x" + "1".repeat(40) })).toEqual([first]);
    expect(first.origin.netAmount).toBe("9970000");
  });
  it("reports missing deployment metadata instead of representing it as no matching history", () => {
    const base = transfer();
    expect(filterSupportError([base], { deployment: "b".repeat(64) })).toContain("unavailable");
    expect(filterSupportError([base], { asset: "0x" + "1".repeat(40) })).toBeNull();
    expect(filterSupportError([], { deployment: "b".repeat(64) })).toBeNull();
  });
  it("preserves real destination metadata through the indexer response", async () => {
    vi.stubEnv("NEXT_PUBLIC_HYPERION_API_URL", "https://indexer.example");
    const record = transfer({
      destination: {
        chain: "sepolia",
        recipient: "0x" + "a".repeat(40),
        token: "0x" + "1".repeat(40),
        symbol: "USDC",
        representation: "native",
        decimals: 6,
        amount: "1234567",
        delivered: true,
        txHash: "0x" + "b".repeat(64),
        block: "1",
        deliveredAt: "2026-11-19T12:00:00.000Z",
      },
    });
    const response = { transfers: [record], count: 1, limit: 20, offset: 0 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response))));
    expect((await fetchTransfers()).transfers[0]?.destination).toEqual(record.destination);
  });

  it("keeps provider execution as a candidate until a destination transaction exists", () => {
    const stages = getEvidenceTimeline(transfer());
    expect(stages.map((stage) => stage.status)).toEqual(["confirmed", "candidate", "pending"]);
    expect(stages[1]?.href).toBeUndefined();
    expect(hasVerifiedDestinationEvidence(transfer())).toBe(false);
  });

  it("requires the independently indexed destination transaction for verification", () => {
    const record = transfer({
      stage: "delivered",
      destination: {
        chain: "sepolia",
        recipient: "0x0000000000000000000000000000000000000001",
        delivered: true,
        block: "456",
        txHash: "destination-hash",
        deliveredAt: "2026-11-18T12:05:00.000Z",
      },
    });
    const stages = getEvidenceTimeline(record);
    expect(stages[2]?.status).toBe("verified");
    expect(stages[2]?.href).toBe("https://sepolia.etherscan.io/tx/destination-hash");
    expect(hasVerifiedDestinationEvidence(record)).toBe(true);
  });

  it("marks a delivered flag without public proof as unknown", () => {
    const record = transfer({
      destination: {
        chain: "sepolia",
        recipient: "0x0000000000000000000000000000000000000001",
        delivered: true,
        block: null,
        txHash: null,
        deliveredAt: null,
      },
    });
    expect(getEvidenceTimeline(record)[2]?.status).toBe("unknown");
  });
});

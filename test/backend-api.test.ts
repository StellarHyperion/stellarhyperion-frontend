import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cursorFreshness,
  fetchIndexerMetrics,
  fetchClaims,
  fetchTransferByTx,
  fetchTransfers,
  filterTransfers,
  reconcileTransfers,
  localTransferMatches,
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
import {
  assertIndexedAcceptance,
  assertPaymentReceipt,
  assertSignedSource,
} from "./support/acceptance";
import { defaultProofFile } from "./support/proof-file";
import { readTransaction } from "../src/contracts/stellar";
import { TESTNET } from "../src/config/testnet";
import type { LocalTransferReference } from "../src/lib/local-transfers";
import { createPublicClient, http } from "viem";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const TESTNET_USDC = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const origin = (
  overrides: Partial<FormattedTransfer["origin"]> = {},
): FormattedTransfer["origin"] => ({
  chain: "stellar-testnet",
  nonce: "1",
  sender: "GABC",
  token: TESTNET_USDC,
  symbol: "USDC",
  decimals: 7,
  grossAmount: "1000000",
  fee: "3000",
  netAmount: "997000",
  block: "100",
  txHash: "a".repeat(64),
  observedAt: "2026-10-29T00:00:00.000Z",
  ...overrides,
});
const destination = (
  overrides: Partial<FormattedTransfer["destination"]> = {},
): FormattedTransfer["destination"] => ({
  token: "0xFd5a146686d16060ef9c595B37C30b248402304c",
  amount: "997000",
  symbol: "USDC",
  decimals: 7,
  chain: "sepolia",
  recipient: `0x${"1".repeat(40)}`,
  delivered: true,
  block: "200",
  txHash: "0x" + "b".repeat(64),
  deliveredAt: "2026-10-29T00:05:00.000Z",
  ...overrides,
});
function record(
  originOverrides: Partial<FormattedTransfer["origin"]> = {},
  destinationOverrides: Partial<FormattedTransfer["destination"]> | null = {},
): FormattedTransfer {
  const sourceOnly = destinationOverrides === null || destinationOverrides.delivered === false;
  return {
    id: "1",
    stage: sourceOnly ? "attested" : "delivered",
    route: 1,
    origin: origin(originOverrides),
    destination:
      destinationOverrides === null
        ? destination({
            delivered: false,
            txHash: null,
            amount: null,
            block: null,
            deliveredAt: null,
          })
        : destination(destinationOverrides),
    rail: null,
    claim: null,
  };
}

describe("account-scoped local source reconciliation", () => {
  const account = Keypair.random().publicKey();
  const reference = (hash = "a".repeat(64)): LocalTransferReference => ({
    checkpoint: {
      router: TESTNET.router,
      token: TESTNET.token,
      account,
      recipient: `0x${"1".repeat(40)}`,
      destination: "sepolia",
      route: 1,
      bridgeAmount: "1000000",
      stage: "bridge",
      txHash: hash,
    },
    sourceStatus: "confirmed",
  });
  const matching = (hash = "a".repeat(64)) =>
    record({ sender: account, txHash: hash, token: TESTNET.token, router: TESTNET.router });

  it("preserves confirmed references independently for missing, error and matching reads", async () => {
    vi.stubEnv("NEXT_PUBLIC_HYPERION_API_URL", "https://indexer.example");
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.endsWith("a".repeat(64)))
          return Promise.resolve(new Response("{}", { status: 404 }));
        if (url.endsWith("b".repeat(64)))
          return Promise.resolve(new Response("{}", { status: 503 }));
        return Promise.resolve(Response.json(matching("c".repeat(64))));
      }),
    );
    const refs = [reference(), reference("b".repeat(64)), reference("c".repeat(64))];
    const result = await reconcileTransfers(account, refs);
    expect(result.map((item) => item.reference)).toEqual(refs);
    expect(result[0]).toMatchObject({ transfer: null, error: null });
    expect(result[1]?.error).toContain("503");
    expect(result[2]?.transfer).toEqual(matching("c".repeat(64)));
    expect(refs.every((item) => item.sourceStatus === "confirmed")).toBe(true);
  });

  it("never requests or merges another account, chain, hash, token or router", async () => {
    vi.stubEnv("NEXT_PUBLIC_HYPERION_API_URL", "https://indexer.example");
    const fetcher = vi.fn(() => Promise.resolve(Response.json(matching())));
    vi.stubGlobal("fetch", fetcher);
    const foreign = {
      ...reference(),
      checkpoint: { ...reference().checkpoint, account: Keypair.random().publicKey() },
    };
    expect(await reconcileTransfers(account, [foreign])).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    for (const change of [
      { sender: foreign.checkpoint.account },
      { chain: "stellar-mainnet" },
      { txHash: "d".repeat(64) },
      { token: "other-token" },
      { router: "other-router" },
      { router: null },
    ]) {
      expect(
        localTransferMatches(reference(), {
          ...matching(),
          origin: { ...matching().origin, ...change },
        }),
      ).toBe(false);
    }
    const { router: omittedRouter, ...withoutRouter } = matching().origin;
    expect(omittedRouter).toBe(TESTNET.router);
    expect(localTransferMatches(reference(), { ...matching(), origin: withoutRouter })).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            ...matching(),
            origin: { ...matching().origin, sender: foreign.checkpoint.account },
          }),
        ),
      ),
    );
    expect((await reconcileTransfers(account, [reference()]))[0]).toMatchObject({ transfer: null });
  });

  it("bounds compatibility reads to 20 unique hashes and four concurrent requests", async () => {
    vi.stubEnv("NEXT_PUBLIC_HYPERION_API_URL", "https://indexer.example");
    let active = 0,
      maximum = 0,
      calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return new Response("{}", { status: 404 });
      }),
    );
    const refs = Array.from({ length: 30 }, (_, index) =>
      reference(index.toString(16).padStart(64, "0")),
    );
    expect((await reconcileTransfers(account, [...refs.slice(0, 1), ...refs])).length).toBe(20);
    expect(calls).toBe(20);
    expect(maximum).toBe(4);
  });

  it("preserves statuses and makes no requests after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const result = await reconcileTransfers(account, [reference()], controller.signal);
    expect(result[0]?.reference.sourceStatus).toBe("confirmed");
    expect(result[0]?.error).toContain("cancelled");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
/**
 * Enforces the public acceptance proof schema: a real signed source transaction is not enough on
 * its own, every reported amount is an exact integer (never a float or scientific-notation string),
 * and destination evidence always names the issuer-specific token that actually paid out.
 */
function assertAcceptedProofSchema(
  transfer: FormattedTransfer | null,
  sourceHash = "a".repeat(64),
): void {
  assertIndexedAcceptance(transfer, {
    sourceHash,
    sender: "GABC",
    sourceToken: TESTNET_USDC,
    grossAmount: "1000000",
    fee: "3000",
    destination: "sepolia",
    recipient: `0x${"1".repeat(40)}`,
    destinationToken: "0xFd5a146686d16060ef9c595B37C30b248402304c",
    destinationAmount: "997000",
    route: 1,
  });
}
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
  it("preserves generated source and destination base-unit strings independently", async () => {
    vi.stubEnv("NEXT_PUBLIC_HYPERION_API_URL", "https://indexer.example");
    const transfer = (sourceGross: bigint, index: number): FormattedTransfer => {
      const fee = BigInt(index + 1) * 100n;
      const sourceNet = sourceGross - fee;
      return {
        id: `amount-${index}`,
        stage: "delivered",
        route: 0,
        origin: {
          chain: "stellar-testnet",
          nonce: String(index + 1),
          sender: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          token: "CUSDC",
          symbol: "USDC",
          decimals: 7,
          grossAmount: sourceGross.toString(),
          fee: fee.toString(),
          netAmount: sourceNet.toString(),
          block: String(index + 100),
          txHash: `source-${index}`,
          observedAt: "2026-11-18T12:00:00.000Z",
        },
        destination: {
          token: "0x" + "1".repeat(40),
          amount: (sourceNet / 10n).toString(),
          symbol: "USDC",
          decimals: 6,
          chain: "sepolia",
          recipient: "0x" + "2".repeat(40),
          delivered: true,
          block: String(index + 200),
          txHash: `destination-${index}`,
          deliveredAt: "2026-11-18T12:05:00.000Z",
        },
        rail: null,
        claim: null,
      };
    };
    let state = 0x159c0de;
    const records = [
      transfer(9007199254740993n, 0),
      ...Array.from({ length: 32 }, (_, index) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return transfer(BigInt(state) * 100000000n + 1000000n, index + 1);
      }),
    ];
    const payload = { transfers: records, count: records.length, limit: 50, offset: 0 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));

    const result = await fetchTransfers();
    for (const [index, record] of records.entries()) {
      expect(result.transfers[index]?.origin.grossAmount).toBe(record.origin.grossAmount);
      expect(result.transfers[index]?.origin.fee).toBe(record.origin.fee);
      expect(result.transfers[index]?.origin.netAmount).toBe(record.origin.netAmount);
      expect(result.transfers[index]?.destination.amount).toBe(record.destination.amount);
    }
    expect(result.transfers[0]?.origin.grossAmount).toBe("9007199254740993");
  });

  it("passes a keyset cursor when the backend advertises cursor pagination", async () => {
    vi.stubEnv("NEXT_PUBLIC_HYPERION_API_URL", "https://indexer.example");
    const payload = {
      transfers: [],
      count: 0,
      limit: 20,
      offset: 0,
      cursor: "after-1",
      nextCursor: null,
      hasMore: false,
    };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload)));
    vi.stubGlobal("fetch", fetcher);
    expect(await fetchTransfers({ limit: "20", cursor: "after-1" })).toEqual(payload);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://indexer.example/v1/transfers?limit=20&cursor=after-1",
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
describe("Public acceptance proof schema", () => {
  it("rejects source-only completion as insufficient for cross-chain acceptance", () => {
    const sourceOnly = record({}, null);
    expect(sourceOnly.destination.delivered).toBe(false);
    expect(sourceOnly.destination.txHash).toBeNull();
    expect(() => {
      assertAcceptedProofSchema(sourceOnly);
    }).toThrow("cannot satisfy cross-chain acceptance");
  });
  it("rejects amounts that are not exact integers", () => {
    expect(() => {
      assertAcceptedProofSchema(record({ grossAmount: "1.5" }));
    }).toThrow("exact integer");
    expect(() => {
      assertAcceptedProofSchema(record({ fee: "3e3" }));
    }).toThrow("exact integer");
    expect(() => {
      assertAcceptedProofSchema(record({}, { amount: "997000.0" }));
    }).toThrow("exact integer");
  });
  it("rejects destination evidence missing issuer-specific token identity", () => {
    expect(() => {
      assertAcceptedProofSchema(record({}, { token: null }));
    }).toThrow("issuer-specific token identity");
  });
  it("rejects evidence that does not match the real signed source transaction", () => {
    expect(() => {
      assertAcceptedProofSchema(record(), "f".repeat(64));
    }).toThrow("does not match the real signed source transaction");
  });
  it("accepts a fully delivered record with exact integer amounts and real token identity", () => {
    const delivered = record();
    expect(() => {
      assertAcceptedProofSchema(delivered, delivered.origin.txHash);
    }).not.toThrow();
    expect(delivered.destination.token).toBe("0xFd5a146686d16060ef9c595B37C30b248402304c");
    expect(delivered.origin.grossAmount).toBe("1000000");
  });
  // Explicit opt-in only: reads the real indexer configured by NEXT_PUBLIC_HYPERION_API_URL and
  // checks the proof file a prior live-transfer run saved. Normal checks never need credentials
  // or reach a real indexer, and this suite is skipped unless the live gate is set.
  const liveEnabled = process.env.HYPERION_LIVE_PROOF === "1";
  it.skipIf(!liveEnabled)(
    "validates real indexed evidence for a real signed transfer against the public proof schema",
    async () => {
      const file = process.env.HYPERION_TESTNET_PROOF ?? defaultProofFile();
      if (!existsSync(file))
        throw new Error(
          "Run the live transfer suite first (HYPERION_LIVE_TESTNET=1) so a real source hash is recorded.",
        );
      const proof = JSON.parse(readFileSync(file, "utf8")) as {
        sourceHash?: string;
        sourceEnvelope?: string;
        sender: string;
        recipient: string;
        grossAmount: string;
        fee: string;
        destinationAmount: string;
      };
      if (!proof.sourceHash)
        throw new Error("The saved proof has no signed source transaction hash yet.");
      const transfer = await fetchTransferByTx(proof.sourceHash);
      if (!proof.sourceEnvelope)
        throw new Error(
          "The proof is missing its public signed source envelope; retain the unresolved hash.",
        );
      assertSignedSource(proof.sourceEnvelope, proof.sender, proof.sourceHash);
      expect((await readTransaction(proof.sourceHash))?.status).toBe("confirmed");
      const intent = {
        sourceHash: proof.sourceHash,
        sender: proof.sender,
        sourceToken: TESTNET.token,
        grossAmount: proof.grossAmount,
        fee: proof.fee,
        destination: "sepolia",
        recipient: proof.recipient,
        destinationToken: "0xFd5a146686d16060ef9c595B37C30b248402304c",
        destinationAmount: proof.destinationAmount,
        route: 1,
      };
      assertIndexedAcceptance(transfer, intent);
      const remote = createPublicClient({
        transport: http("https://ethereum-sepolia-rpc.publicnode.com", { timeout: 15000 }),
      });
      expect(await remote.getChainId()).toBe(11155111);
      assertPaymentReceipt(
        await remote.getTransactionReceipt({ hash: transfer.destination.txHash as `0x${string}` }),
        transfer,
        intent,
      );
    },
    30_000,
  );
});

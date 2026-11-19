import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as TestnetConfig from "../src/config/testnet";
let config: typeof TestnetConfig;
let values: Map<string, string>;
beforeEach(async () => {
  vi.resetModules();
  config = await import("../src/config/testnet");
  values = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("deployment-aware asset metadata", () => {
  it("separates same-symbol issuers, networks and deployment revisions", () => {
    const { getPublicAssetMetadata, TESTNET } = config;
    const first = getPublicAssetMetadata("USDC", TESTNET.usdcIssuer, 1_000_000);
    const otherIssuer = getPublicAssetMetadata("USDC", TESTNET.reader, 1_000_000);
    const otherNetwork = getPublicAssetMetadata("USDC", TESTNET.usdcIssuer, 1_000_000, {
      network: "stellar-mainnet",
      deploymentCommit: first.deploymentCommit,
    });
    const otherRevision = getPublicAssetMetadata("USDC", TESTNET.usdcIssuer, 1_000_000, {
      network: first.network,
      deploymentCommit: "a".repeat(40),
    });
    expect(
      new Set([first, otherIssuer, otherNetwork, otherRevision].map((value) => value.key)).size,
    ).toBe(4);
    expect(first.network).toBe("stellar-testnet");
    expect(first.decimals).toBe(7);
  });

  it("expires metadata without changing immutable transaction configuration", () => {
    const { getPublicAssetMetadata, readCachedAssetMetadata, TESTNET } = config;
    const before = { ...TESTNET };
    const metadata = getPublicAssetMetadata("USDC", TESTNET.usdcIssuer, 2_000_000);
    expect(readCachedAssetMetadata("USDC", TESTNET.usdcIssuer, 2_300_000)?.stale).toBe(false);
    expect(readCachedAssetMetadata("USDC", TESTNET.usdcIssuer, 2_300_001)).toEqual({
      ...metadata,
      stale: true,
    });
    expect(TESTNET).toEqual(before);
  });

  it("bounds memory and persistent public metadata while preserving recovery storage", () => {
    values.set("hyperion.testnet.pending-transfer", "existing signed hash");
    const { getPublicAssetMetadata, readCachedAssetMetadata, TESTNET } = config;
    for (let index = 0; index < 70; index++)
      getPublicAssetMetadata(`T${index}`, TESTNET.usdcIssuer, 1_000_000);
    expect(readCachedAssetMetadata("T0", TESTNET.usdcIssuer, 1_000_000)).toBeNull();
    expect(readCachedAssetMetadata("T69", TESTNET.usdcIssuer, 1_000_000)).not.toBeNull();
    expect(values.size).toBe(66);
    expect(values.get("hyperion.testnet.pending-transfer")).toBe("existing signed hash");
  });

  it("validates persisted identity, precision, deployment and observation timestamps", async () => {
    const { TESTNET } = config;
    const fresh = config.getPublicAssetMetadata("USDC", TESTNET.usdcIssuer, 2_000_000);
    vi.resetModules();
    const reader = await import("../src/config/testnet");
    for (const mutation of [
      { code: "FAKE" },
      { issuer: TESTNET.reader },
      { network: "stellar-mainnet" },
      { deploymentCommit: "b".repeat(40) },
      { decimals: 6 },
      { observedAt: "invalid" },
      { observedAt: new Date(2_000_001).toISOString() },
    ]) {
      values.set(fresh.key, JSON.stringify({ ...fresh, ...mutation }));
      expect(reader.readCachedAssetMetadata("USDC", TESTNET.usdcIssuer, 2_000_000)).toBeNull();
    }
    values.set(fresh.key, "x".repeat(1025));
    expect(reader.readCachedAssetMetadata("USDC", TESTNET.usdcIssuer, 2_000_000)).toBeNull();
  });

  it("keeps uncached public metadata available when persistent storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    const { TESTNET } = config;
    expect(config.getPublicAssetMetadata("USDC", TESTNET.usdcIssuer, 2_000_000)).toMatchObject({
      code: "USDC",
      issuer: TESTNET.usdcIssuer,
      stale: false,
    });
  });

  it("reuses bounded search metadata during an outage with an explicit stale source", async () => {
    const { TESTNET } = config;
    const { searchAssets, issuerVerificationLabel } = await import("../src/contracts/assets");
    vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          _embedded: { records: [{ asset_code: "USDC", asset_issuer: TESTNET.reader }] },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const observed = await searchAssets("USDC");
    expect(observed[0]?.metadata?.stale).toBe(false);
    fetcher.mockRejectedValue(new Error("offline"));
    vi.spyOn(Date, "now").mockReturnValue(2_300_001);
    const cached = await searchAssets("USDC");
    expect(cached[0]).toMatchObject({
      code: "USDC",
      issuer: TESTNET.reader,
      verification: "cached-metadata",
      trustline: "not-checked",
      metadata: { stale: true },
    });
    expect(cached[0]).not.toHaveProperty("balance");
    const first = cached[0];
    if (!first) throw new Error("Missing cached asset.");
    expect(issuerVerificationLabel(first)).toContain("stale; verify before signing");
    await expect(searchAssets("UNSEEN")).rejects.toThrow("offline");
  });
});

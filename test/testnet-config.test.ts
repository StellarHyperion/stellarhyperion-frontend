import { describe, expect, it } from "vitest";
import {
  getPublicAssetMetadata,
  readCachedAssetMetadata,
  TESTNET,
} from "../src/config/testnet";

describe("deployment-aware asset metadata", () => {
  it("keys same-symbol assets by network and issuer", () => {
    const first = getPublicAssetMetadata("USDC", TESTNET.usdcIssuer, 1_000_000);
    const second = getPublicAssetMetadata("USDC", TESTNET.reader, 1_000_000);
    expect(first.key).not.toBe(second.key);
    expect(first.network).toBe("stellar-testnet");
    expect(first.deploymentCommit).toBeTruthy();
  });

  it("marks expired cached metadata stale without changing transaction config", () => {
    const now = 2_000_000;
    getPublicAssetMetadata("USDC", TESTNET.usdcIssuer, now);
    const cached = readCachedAssetMetadata("USDC", TESTNET.usdcIssuer, now + 300_001);
    expect(cached?.stale).toBe(true);
    expect(cached?.issuer).toBe(TESTNET.usdcIssuer);
  });
});

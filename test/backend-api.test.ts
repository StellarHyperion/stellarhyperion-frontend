import { describe, expect, it } from "vitest";
import {
  fetchClaims,
  fetchTransferByNonce,
  fetchTransferByTx,
  fetchTransfers,
  getRouteName,
} from "../src/api/backend";

describe("Backend API Client & Fixture Filtering", () => {
  it("maps numeric route kinds to human-readable names", () => {
    expect(getRouteName(0)).toBe("CCTP");
    expect(getRouteName(1)).toBe("Axelar ITS");
    expect(getRouteName(2)).toBe("Axelar GMP");
    expect(getRouteName(3)).toBe("Allbridge");
    expect(getRouteName(99)).toBe("Route 99");
  });

  it("returns default transfer list when called without filters", async () => {
    const res = await fetchTransfers();
    expect(res.transfers.length).toBeGreaterThan(0);
    expect(res.count).toBe(res.transfers.length);
  });

  it("filters transfers by origin and destination chain", async () => {
    const res = await fetchTransfers({ destinationChain: "arc-testnet" });
    expect(res.transfers.every((t) => t.destination.chain === "arc-testnet")).toBe(true);
    expect(res.transfers.length).toBeGreaterThanOrEqual(1);
  });

  it("filters transfers by route index", async () => {
    const res = await fetchTransfers({ route: "1" });
    expect(res.transfers.every((t) => t.route === 1)).toBe(true);
  });

  it("filters transfers by search string (txHash, address, or nonce)", async () => {
    const res = await fetchTransfers({ search: "105" });
    expect(res.transfers.some((t) => t.origin.nonce === "105")).toBe(true);
  });

  it("looks up transfer by origin tx hash", async () => {
    const targetTx = "0x3a4b7f91c8e26d0481fa39b7829dc74828392019485720194827392819482910";
    const found = await fetchTransferByTx(targetTx);
    expect(found).not.toBeNull();
    expect(found?.origin.txHash).toBe(targetTx);
    expect(found?.stage).toBe("delivered");
  });

  it("looks up transfer by destination tx hash", async () => {
    const destTx = "0x89ab12cd34ef5678901234567890123456789012345678901234567890abcdef";
    const found = await fetchTransferByTx(destTx);
    expect(found).not.toBeNull();
    expect(found?.destination.txHash).toBe(destTx);
  });

  it("returns null for unknown tx hash", async () => {
    const found = await fetchTransferByTx(
      "0xdeadbeef00000000000000000000000000000000000000000000000000000000",
    );
    expect(found).toBeNull();
  });

  it("looks up transfer by chain and nonce", async () => {
    const found = await fetchTransferByNonce("stellar-testnet", "104");
    expect(found).not.toBeNull();
    expect(found?.origin.nonce).toBe("104");
  });

  it("queries and filters parked claims", async () => {
    const allClaims = await fetchClaims();
    expect(allClaims.claims.length).toBeGreaterThan(0);

    const settledClaims = await fetchClaims({ settled: "true" });
    expect(settledClaims.claims.every((c) => c.settled)).toBe(true);

    const pendingClaims = await fetchClaims({ settled: "false" });
    expect(pendingClaims.claims.every((c) => !c.settled)).toBe(true);
  });
});

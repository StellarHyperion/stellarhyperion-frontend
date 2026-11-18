import { describe, expect, it } from "vitest";
import { type FormattedTransfer } from "../src/api";
import { getEvidenceAwareStage, getEvidenceTimeline } from "../src/lib/evidence";

const transfer = (overrides: Partial<FormattedTransfer> = {}): FormattedTransfer => ({
  id: "transfer-1",
  stage: "delivering",
  route: 0,
  origin: {
    chain: "stellar-testnet",
    nonce: "1",
    sender: "GABC",
    token: "CUSDC",
    grossAmount: "1000000",
    fee: "1000",
    netAmount: "999000",
    block: "1",
    txHash: "source-hash",
    observedAt: "2026-11-18T00:00:00Z",
  },
  destination: {
    chain: "ethereum-sepolia",
    recipient: "0xrecipient",
    delivered: false,
    block: null,
    txHash: null,
    deliveredAt: null,
  },
  rail: null,
  claim: null,
  ...overrides,
});

describe("transfer evidence timeline", () => {
  it("does not publish provider URLs containing embedded credentials", () => {
    const result = transfer({
      rail: {
        status: "candidate",
        railStatus: "pending",
        reference: "https://user:private@example.com/transfer",
        attestedAt: null,
        lastError: null,
      },
    });
    expect(getEvidenceTimeline(result)[1]?.href).toBeUndefined();
  });
  it("keeps provider execution separate from verified destination delivery", () => {
    const result = transfer({
      stage: "delivered",
      rail: {
        status: "executed",
        railStatus: "executed",
        reference: "provider-candidate-1",
        attestedAt: "2026-11-18T00:01:00Z",
        lastError: null,
      },
    });

    expect(getEvidenceTimeline(result).map((stage) => stage.status)).toEqual([
      "confirmed",
      "candidate",
      "pending",
    ]);
    expect(getEvidenceAwareStage(result)).toBe("destination pending");
  });

  it("links only source and independently verified destination proofs", () => {
    const result = transfer({
      rail: {
        status: "candidate",
        railStatus: "candidate",
        reference: "not-a-public-url",
        attestedAt: null,
        lastError: null,
      },
      destination: {
        chain: "ethereum-sepolia",
        recipient: "0xrecipient",
        delivered: true,
        block: "2",
        txHash: "destination-hash",
        deliveredAt: "2026-11-18T00:02:00Z",
      },
    });

    const timeline = getEvidenceTimeline(result);
    expect(timeline[0]?.href).toContain("stellar.expert");
    expect(timeline[1]?.href).toBeUndefined();
    expect(timeline[2]?.status).toBe("verified");
    expect(timeline[2]?.href).toContain("etherscan.io");
  });
});

import { describe, expect, it } from "vitest";
import { deliveryProofState } from "../src/lib/proof-state";
import type { FormattedTransfer } from "../src/api/backend";

const transfer = (overrides: Partial<FormattedTransfer> = {}): FormattedTransfer => ({
  id: "1",
  stage: "delivered",
  route: 0,
  origin: {
    chain: "stellar-testnet",
    nonce: "1",
    sender: "G...",
    token: "C...",
    grossAmount: "10",
    fee: "1",
    netAmount: "9",
    block: "1",
    txHash: "a".repeat(64),
    observedAt: "2026-01-01",
  },
  destination: {
    chain: "sepolia",
    recipient: "0x1111111111111111111111111111111111111111",
    delivered: true,
    amount: "8",
    decimals: 6,
    txHash: "b".repeat(64),
    symbol: "USDC",
    token: "USDC",
    block: "2",
    deliveredAt: "2026-01-01",
  },
  rail: null,
  claim: null,
  ...overrides,
});

describe("delivery proof state", () => {
  it("requires destination payment evidence before rendering delivered", () => {
    expect(
      deliveryProofState(transfer({ destination: { ...transfer().destination, txHash: null } }), {
        status: "confirmed",
        txHash: "a".repeat(64),
      }),
    ).toBe("unresolved");
    expect(deliveryProofState(transfer(), { status: "confirmed", txHash: "a".repeat(64) })).toBe(
      "delivered",
    );
  });
  it("keeps failed and unresolved evidence distinct", () => {
    expect(deliveryProofState(transfer({ stage: "failed" }), null)).toBe("failed");
    expect(deliveryProofState(null, { status: "confirmed", txHash: "a".repeat(64) })).toBe(
      "unresolved",
    );
  });
});

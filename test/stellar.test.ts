import { afterEach, describe, expect, it, vi } from "vitest";
import { Account, Contract, TransactionBuilder, scValToNative } from "@stellar/stellar-sdk";
import {
  bridgeOperation,
  diagnoseSequence,
  parseSendAmount,
  readTransaction,
  reconcileSignatureReturn,
  validateRecipient,
  validateReviewMatch,
  type LiveQuote,
  type ReviewSnapshot,
} from "../src/contracts/stellar";
import {
  claimOperationOwnership,
  getOperationOwnership,
  releaseOperationOwnership,
  saveCheckpoint,
  type TransferCheckpoint,
} from "../src/contracts/checkpoint";
import { TESTNET } from "../src/config/testnet";
const quote: LiveQuote = {
  route: 1,
  adapter: TESTNET.router,
  destination: "sepolia",
  requestedAmount: 10000009n,
  grossAmount: 10000009n,
  fee: 30000n,
  netAmount: 9970009n,
  destinationAmount: 9970009n,
  flowAvailable: 10000000000n,
  ledger: 1,
  relayGas: 1051082n,
};
afterEach(() => vi.unstubAllGlobals());
describe("Real Stellar transaction encoding", () => {
  it("keeps values beyond Number precision exact and rejects invalid amounts", () => {
    expect(parseSendAmount("900719925.4740993")).toBe(9007199254740993n);
    for (const value of ["", "0", "-1", "1.12345678", "1e3", "NaN", "1,000"])
      expect(() => parseSendAmount(value)).toThrow();
  });
  it("requires a real nonzero EVM destination", () => {
    expect(validateRecipient("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")).toMatch(/^0x/);
    for (const value of ["", "0x123", "0x" + "0".repeat(40), TESTNET.reader])
      expect(() => validateRecipient(value)).toThrow();
  });
  it("builds the actual paid router call and includes exact amounts, gas and destination", () => {
    const operation = bridgeOperation(
      TESTNET.reader,
      quote,
      "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    );
    const tx = new TransactionBuilder(new Account(TESTNET.reader, "0"), {
      fee: "100",
      networkPassphrase: TESTNET.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(60)
      .build();
    const decoded = TransactionBuilder.fromXdr(tx.toXdr(), TESTNET.networkPassphrase);
    const op = decoded.operations[0];
    expect(op?.type).toBe("invokeHostFunction");
    if (op?.type !== "invokeHostFunction") throw new Error("Wrong operation");
    if (op.func.type !== "hostFunctionTypeInvokeContract") throw new Error("Wrong host function");
    const invocation = op.func.invokeContract;
    expect(invocation.functionName.toString()).toBe("bridge_out_with_gas");
    const args = invocation.args;
    if (!args[1] || !args[2]) throw new Error("Missing request or relay gas");
    const request = scValToNative(args[1]) as {
      amount: bigint;
      min_destination_amount: bigint;
      destination_decimals: number;
      destination: { chain: string; address: Uint8Array };
    };
    expect(request.amount).toBe(10000009n);
    expect(request.destination_decimals).toBe(7);
    expect(request.min_destination_amount).toBe(9970009n);
    expect(request.destination.chain).toBe("sepolia");
    expect(request.destination.address.length).toBe(32);
    expect(scValToNative(args[2])).toBe(1051082n);
    expect(new Contract(TESTNET.router).contractId()).toBe(TESTNET.router);
  });
  it("does not query arbitrary malformed transaction IDs", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(await readTransaction("0xnot-a-stellar-tx")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("encodes Circle's post-forwarding receive minimum with six-decimal native USDC", () => {
    const operation = bridgeOperation(
      TESTNET.reader,
      { ...quote, route: 0, destinationAmount: 900000n, relayGas: 500000n },
      "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    );
    const tx = new TransactionBuilder(new Account(TESTNET.reader, "0"), {
      fee: "100",
      networkPassphrase: TESTNET.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(60)
      .build();
    const op = tx.operations[0];
    if (op?.type !== "invokeHostFunction" || op.func.type !== "hostFunctionTypeInvokeContract")
      throw new Error("Wrong bridge operation.");
    const encodedRequest = op.func.invokeContract.args[1];
    if (!encodedRequest) throw new Error("Missing bridge request.");
    const request = scValToNative(encodedRequest) as {
      route: number;
      destination_decimals: number;
      min_destination_amount: bigint;
    };
    expect(request.route).toBe(0);
    expect(request.destination_decimals).toBe(6);
    expect(request.min_destination_amount).toBe(900000n);
  });
  describe("Signature return reconciliation and review state matching", () => {
    const baseReview: ReviewSnapshot = {
      account: TESTNET.reader,
      recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
      destination: "sepolia",
      route: 1,
      bridgeAmount: 9007199254740993n,
      stage: "bridge",
      sourceId: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      sourceAmount: 9007199254740993n,
    };

    it("accepts an exact review match with identical integer amounts and token identity", () => {
      expect(validateReviewMatch(baseReview, { ...baseReview })).toBe(true);
      const result = reconcileSignatureReturn(
        baseReview,
        { ...baseReview },
        TESTNET.reader,
        "a".repeat(64),
      );
      expect(result).toEqual({ valid: true });
    });

    it("rejects an altered integer amount or different issuer token identity", () => {
      expect(
        validateReviewMatch(baseReview, { ...baseReview, bridgeAmount: 9007199254740994n }),
      ).toBe(false);
      expect(
        validateReviewMatch(baseReview, {
          ...baseReview,
          sourceId: "USDC:GDIFFERENTISSUER335X2KGX3IHOJAPP5RE34K4KZVN",
        }),
      ).toBe(false);
      const result = reconcileSignatureReturn(
        baseReview,
        { ...baseReview, bridgeAmount: 1000n },
        TESTNET.reader,
        "a".repeat(64),
      );
      expect(result).toEqual({ valid: false, reason: "superseded" });
    });

    it("detects an account switch when the active wallet differs from the review owner", () => {
      const result = reconcileSignatureReturn(
        baseReview,
        { ...baseReview },
        "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        "a".repeat(64),
      );
      expect(result).toEqual({ valid: false, reason: "account_switch" });
    });

    it("coordinates operation ownership under concurrent operations", () => {
      const op1 = claimOperationOwnership({
        account: TESTNET.reader,
        recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        destination: "sepolia",
        route: 1,
        bridgeAmount: "1000000",
        stage: "bridge",
      });
      expect(getOperationOwnership()?.id).toBe(op1.id);

      const op2 = claimOperationOwnership({
        account: TESTNET.reader,
        recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        destination: "sepolia",
        route: 1,
        bridgeAmount: "2000000",
        stage: "bridge",
      });
      expect(getOperationOwnership()?.id).toBe(op2.id);
      expect(getOperationOwnership()?.id).not.toBe(op1.id);

      releaseOperationOwnership(op2.id);
      expect(getOperationOwnership()).toBeNull();
    });

    it("diagnoses matching sequence between constructed intent and ledger state", () => {
      const result = diagnoseSequence("101", "100");
      expect(result.valid).toBe(true);
      expect(result.expectedSequence).toBe("100");
      expect(result.ledgerSequence).toBe("100");
      expect(result.reason).toBeNull();
    });

    it("diagnoses sequence mismatch when ledger sequence has changed", () => {
      const result = diagnoseSequence("101", "101");
      expect(result.valid).toBe(false);
      expect(result.expectedSequence).toBe("100");
      expect(result.ledgerSequence).toBe("101");
      expect(result.reason).toContain("sequence changed from 100 to 101");
    });

    it("preserves unknown previous submissions in recovery rather than replacing them", () => {
      const cp1: TransferCheckpoint = {
        router: TESTNET.router,
        account: TESTNET.reader,
        recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        destination: "sepolia",
        route: 1,
        bridgeAmount: "1000000",
        stage: "bridge",
        txHash: "1".repeat(64),
      };
      const cp2: TransferCheckpoint = {
        ...cp1,
        txHash: "2".repeat(64),
      };
      saveCheckpoint(null);
      saveCheckpoint(cp1);
      expect(() => {
        saveCheckpoint(cp2);
      }).toThrow("Previous submissions remain pending");
      saveCheckpoint(null);
    });
  });
});

import { parseClaimPreview } from "../src/contracts/stellar";
import {
  claimOperationOwnership,
  getOperationOwnership,
  releaseOperationOwnership,
  saveCheckpoint,
  type TransferCheckpoint,
} from "../src/contracts/checkpoint";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Account, Contract, TransactionBuilder, rpc, scValToNative } from "@stellar/stellar-sdk";
import {
  bridgeOperation,
  diagnoseSequence,
  claimMatchesDeployment,
  parseSendAmount,
  readTransaction,
  reconcileSignatureReturn,
  validateReviewMatch,
  validateRecipient,
  verifyRouterDeployment,
  type LiveQuote,
  type ReviewSnapshot,
} from "../src/contracts/stellar";
import { STELLAR_DEPLOYMENT, TESTNET } from "../src/config/testnet";
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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("Real Stellar transaction encoding", () => {
  it("keeps unsupported claim previews explicitly unknown", () => {
    expect(parseClaimPreview({ eligible: true }, "preview_settle_claim")).toMatchObject({
      status: "eligible",
      previewMethod: "preview_settle_claim",
    });
    expect(
      parseClaimPreview({ can_settle: false, reason: "Missing trustline" }, "can_settle_claim"),
    ).toMatchObject({ status: "ineligible", reason: "Missing trustline" });
    expect(
      parseClaimPreview({ reason: "No preview result" }, "preview_settle_claim"),
    ).toMatchObject({
      status: "unknown",
      previewMethod: "preview_settle_claim",
    });
  });
  it("only offers recovery for a claim carrying the verified deployment identity", () => {
    const deployment = {
      chain: STELLAR_DEPLOYMENT.chain,
      router: STELLAR_DEPLOYMENT.router,
      wasmHash: STELLAR_DEPLOYMENT.wasmHash,
    };
    expect(claimMatchesDeployment({ deployment }, deployment)).toBe(true);
    expect(
      claimMatchesDeployment({ deployment: { ...deployment, router: "COTHER" } }, deployment),
    ).toBe(false);
    expect(claimMatchesDeployment({ deployment: null }, deployment)).toBe(false);
  });
  it("matches claims only to the exact chain, router and WASM revision", () => {
    const claim = {
      deployment: {
        chain: STELLAR_DEPLOYMENT.chain,
        router: STELLAR_DEPLOYMENT.router,
        wasmHash: STELLAR_DEPLOYMENT.wasmHash,
      },
    };
    expect(claimMatchesDeployment(claim, claim.deployment)).toBe(true);
    for (const change of [
      { chain: "ethereum-sepolia" },
      { router: "COTHER" },
      { wasmHash: "0".repeat(64) },
    ]) {
      expect(
        claimMatchesDeployment(
          { deployment: { ...claim.deployment, ...change } },
          claim.deployment,
        ),
      ).toBe(false);
    }
    expect(claimMatchesDeployment({ deployment: null }, claim.deployment)).toBe(false);
  });
  it("accepts only the configured router's verified on-chain WASM revision", async () => {
    vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: STELLAR_DEPLOYMENT.networkPassphrase,
      protocolVersion: "27",
    });
    vi.spyOn(rpc.Server.prototype, "getContractInstance").mockResolvedValue({
      executable: {
        type: "contractExecutableWasm",
        wasmHash: Uint8Array.from({ length: 32 }, (_, index) =>
          parseInt(STELLAR_DEPLOYMENT.wasmHash.slice(index * 2, index * 2 + 2), 16),
        ),
      },
      storage: null,
    } as never);
    await expect(verifyRouterDeployment()).resolves.toMatchObject({
      router: STELLAR_DEPLOYMENT.router,
      wasmHash: STELLAR_DEPLOYMENT.wasmHash,
      commit: STELLAR_DEPLOYMENT.commit,
    });
  });
  it("rejects an on-chain router revision that is not in the deployment manifest", async () => {
    vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: STELLAR_DEPLOYMENT.networkPassphrase,
      protocolVersion: "27",
    });
    vi.spyOn(rpc.Server.prototype, "getContractInstance").mockResolvedValue({
      executable: { type: "contractExecutableWasm", wasmHash: new Uint8Array(32) },
      storage: null,
    } as never);
    await expect(verifyRouterDeployment()).rejects.toThrow("revision is not verified");
  });
  it("keeps claim recovery read-only when the RPC network is unsupported", async () => {
    vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: "Public Global Stellar Network ; September 2015",
      protocolVersion: "27",
    });
    const contract = vi.spyOn(rpc.Server.prototype, "getContractInstance");
    await expect(verifyRouterDeployment()).rejects.toThrow("not Stellar Testnet");
    expect(contract).not.toHaveBeenCalled();
  });
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
  it("retains an unknown outcome when configured RPC sources disagree", async () => {
    vi.stubEnv("NEXT_PUBLIC_STELLAR_READ_RPC_URLS", "https://rpc-two.testnet.example");
    const getNetwork = vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: TESTNET.networkPassphrase,
      protocolVersion: "27",
    });
    vi.spyOn(rpc.Server.prototype, "getTransaction")
      .mockResolvedValueOnce({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
      } as never)
      .mockResolvedValueOnce({
        status: rpc.Api.GetTransactionStatus.FAILED,
      } as never);

    const result = await readTransaction("a".repeat(64));
    expect(result).toMatchObject({
      status: "pending",
      txHash: "a".repeat(64),
      reason: expect.stringContaining("disagree"),
    });
    expect(getNetwork).toHaveBeenCalledTimes(2);
  });
  it("does not accept transaction evidence from an RPC on another network", async () => {
    vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: "Public Global Stellar Network ; September 2015",
      protocolVersion: "27",
    });
    const getTransaction = vi.spyOn(rpc.Server.prototype, "getTransaction");

    await expect(readTransaction("b".repeat(64))).rejects.toThrow("not Stellar Testnet");
    expect(getTransaction).not.toHaveBeenCalled();
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
      }).toThrow("previous transaction remains pending");
      saveCheckpoint(null);
    });
    it("does not clear a checkpoint that changed in another tab", () => {
      const checkpoint: TransferCheckpoint = {
        router: TESTNET.router,
        account: TESTNET.reader,
        recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        destination: "sepolia",
        route: 1,
        bridgeAmount: "1000000",
        stage: "bridge",
        txHash: "3".repeat(64),
      };
      saveCheckpoint(null);
      saveCheckpoint(checkpoint);

      expect(() => saveCheckpoint(null, "4".repeat(64))).toThrow("changed in another tab");
      saveCheckpoint(checkpoint);
      saveCheckpoint(null, checkpoint.txHash);
    });
    it("does not rewrite or continue a checkpoint from an archived router", () => {
      const checkpoint: TransferCheckpoint = {
        router: "CDMOLDF4SJDEDRWTDF7XAYMSRE6L3YEHHIRF57CFWNQYNC6ZOZ5LWCWF",
        account: TESTNET.reader,
        recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        destination: "sepolia",
        route: 1,
        bridgeAmount: "900719925474099312345",
        stage: "conversion",
        txHash: "5".repeat(64),
      };
      saveCheckpoint(null);
      saveCheckpoint(checkpoint);

      expect(() => saveCheckpoint({ ...checkpoint, router: TESTNET.router })).toThrow(
        "previous transaction remains pending",
      );
      expect(() =>
        saveCheckpoint({ ...checkpoint, stage: "bridge", txHash: "6".repeat(64) }),
      ).toThrow("previous transaction remains pending");
      saveCheckpoint(null, checkpoint.txHash);
    });
    it("retains a pending hash when writes fail but storage reads still work", () => {
      const checkpoint = {
        router: TESTNET.router,
        account: TESTNET.reader,
        recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        destination: "sepolia" as const,
        route: 1 as const,
        bridgeAmount: "1000000",
        stage: "bridge" as const,
        txHash: "a".repeat(64),
      };
      vi.stubGlobal("localStorage", {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota exceeded");
        },
        removeItem: vi.fn(),
      });
      expect(() => {
        saveCheckpoint(checkpoint);
      }).toThrow("Browser storage is unavailable");
      expect(() => {
        saveCheckpoint({ ...checkpoint, txHash: "b".repeat(64) });
      }).toThrow("previous transaction remains pending");
      saveCheckpoint(null);
    });

    it("blocks ownership creation before signing when storage is unavailable", () => {
      vi.stubGlobal("localStorage", {
        setItem: () => {
          throw new Error("quota exceeded");
        },
      });
      expect(() =>
        claimOperationOwnership({
          account: TESTNET.reader,
          recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
          destination: "sepolia",
          route: 1,
          bridgeAmount: "1000000",
          stage: "bridge",
        }),
      ).toThrow("Browser storage is unavailable");
    });
  });
});

import { parseClaimPreview } from "../src/contracts/stellar";
import {
  claimOperationOwnership,
  getOperationOwnership,
  releaseOperationOwnership,
  saveCheckpoint,
  type TransferCheckpoint,
} from "../src/contracts/checkpoint";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Contract,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  bridgeOperation,
  diagnoseSequence,
  validateEnvelopeOperation,
  claimMatchesDeployment,
  parseSendAmount,
  settleClaimsOperation,
  supportsBatchClaimSettlement,
  readTransaction,
  transactionDeadline,
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
  representableAmount: 9970009n,
  flowAvailable: 10000000000n,
  ledger: 1,
  relayGas: 1051082n,
  observedAt: "2026-11-18T20:00:00.000Z",
  scope: {
    destination: "sepolia",
    route: 1,
    adapter: TESTNET.router,
    ledger: 1,
  },
};
afterEach(() => vi.unstubAllGlobals());
describe("Real Stellar transaction encoding", () => {
  it("diagnoses expired envelope bounds before broadcast", () => {
    const transaction = new TransactionBuilder(new Account(TESTNET.reader, "0"), {
      fee: "100",
      networkPassphrase: TESTNET.networkPassphrase,
    })
      .addOperation(new Contract(TESTNET.router).call("noop"))
      .setTimeout(60)
      .build();
    const maxTime = Number(transaction.timeBounds?.maxTime ?? 0);
    const deadline = transactionDeadline(transaction, maxTime + 1);
    expect(deadline.expired).toBe(true);
    expect(deadline.remainingSeconds).toBe(0);
  });
  it("rejects malformed bounds and identifies envelopes before their valid window", () => {
    expect(() => transactionDeadline(null)).toThrow(/bounds/);
    expect(() => transactionDeadline({ timeBounds: { minTime: "-1", maxTime: "60" } })).toThrow(
      /invalid/,
    );
    expect(() => transactionDeadline({ timeBounds: { minTime: "0", maxTime: "0" } })).toThrow(
      /invalid/,
    );
    expect(
      transactionDeadline({ timeBounds: { minTime: "100", maxTime: "200" } }, 99).notYetValid,
    ).toBe(true);
  });

  it("only advertises batch settlement when the router exposes its batch entrypoint", () => {
    const method = (
      name: string,
      elementType: xdr.ScSpecTypeDef = xdr.ScSpecTypeDef.scSpecTypeU64(),
    ) =>
      new xdr.ScSpecFunctionV0({
        doc: "",
        name,
        outputs: [],
        inputs: [
          new xdr.ScSpecFunctionInputV0({
            doc: "",
            name: "sender",
            type: xdr.ScSpecTypeDef.scSpecTypeAddress(),
          }),
          new xdr.ScSpecFunctionInputV0({
            doc: "",
            name: "ids",
            type: xdr.ScSpecTypeDef.scSpecTypeVec(new xdr.ScSpecTypeVec({ elementType })),
          }),
        ],
      });
    expect(supportsBatchClaimSettlement([method("settle_claim")])).toBe(false);
    expect(supportsBatchClaimSettlement([method("settle_claims")])).toBe(true);
    expect(
      supportsBatchClaimSettlement([method("settle_claims", xdr.ScSpecTypeDef.scSpecTypeU32())]),
    ).toBe(false);
    expect(
      supportsBatchClaimSettlement([
        new xdr.ScSpecFunctionV0({ doc: "", name: "settle_claims", inputs: [], outputs: [] }),
      ]),
    ).toBe(false);
  });

  it("encodes every exact claim id in the supported batch entrypoint", () => {
    const operation = settleClaimsOperation(TESTNET.reader, [1n, 9007199254740993n]);
    const tx = new TransactionBuilder(new Account(TESTNET.reader, "0"), {
      fee: "100",
      networkPassphrase: TESTNET.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(60)
      .build();
    const op = tx.operations[0];
    if (op?.type !== "invokeHostFunction" || op.func.type !== "hostFunctionTypeInvokeContract")
      throw new Error("Wrong batch settlement operation.");
    expect(op.func.invokeContract.functionName.toString()).toBe("settle_claims");
    const ids = op.func.invokeContract.args[1];
    if (!ids) throw new Error("Missing claim ids.");
    expect(scValToNative(ids)).toEqual([1n, 9007199254740993n]);
  });

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
    expect(validateRecipient(" 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 ", "sepolia")).toBe(
      "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    );
    expect(() => validateRecipient("0x123", "base-sepolia")).toThrow("Base Sepolia");
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
      }).toThrow("previous transaction remains pending");
      saveCheckpoint(null);
    });

    it("confirms displayed operation matches the exact envelope sent to the wallet", () => {
      const recipient = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
      const op = bridgeOperation(TESTNET.reader, quote, recipient);
      const tx = new TransactionBuilder(new Account(TESTNET.reader, "0"), {
        fee: "100",
        networkPassphrase: TESTNET.networkPassphrase,
      })
        .addOperation(op)
        .setTimeout(60)
        .build();
      expect(validateEnvelopeOperation(op, tx)).toBe(true);
    });

    it("detects when envelope operation does not match displayed operation", () => {
      const recipient = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
      const op1 = bridgeOperation(TESTNET.reader, quote, recipient);
      const alteredQuote: LiveQuote = { ...quote, requestedAmount: 20000000n };
      const op2 = bridgeOperation(TESTNET.reader, alteredQuote, recipient);
      const tx = new TransactionBuilder(new Account(TESTNET.reader, "0"), {
        fee: "100",
        networkPassphrase: TESTNET.networkPassphrase,
      })
        .addOperation(op2)
        .setTimeout(60)
        .build();
      expect(validateEnvelopeOperation(op1, tx)).toBe(false);
    });

    it("keeps amount units and fee categories distinct in review snapshots", () => {
      const snapshot1: ReviewSnapshot = {
        account: TESTNET.reader,
        recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        destination: "sepolia",
        route: 1,
        bridgeAmount: 10000009n,
        stage: "bridge",
        resourceFee: 45000n,
        networkFee: 100n,
      };
      const snapshot2: ReviewSnapshot = {
        ...snapshot1,
        resourceFee: 50000n,
      };
      expect(validateReviewMatch(snapshot1, { ...snapshot1 })).toBe(true);
      expect(validateReviewMatch(snapshot1, snapshot2)).toBe(false);
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

    it.each(["unavailable", "discarded"] as const)(
      "retains the signed hash and blocks another transaction when checkpoint storage is %s",
      (failure) => {
        const checkpoint: TransferCheckpoint = {
          router: TESTNET.router,
          account: TESTNET.reader,
          recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
          destination: "sepolia",
          route: 1,
          bridgeAmount: "1000000",
          stage: "bridge",
          txHash: "a".repeat(64),
        };
        saveCheckpoint(null);
        vi.stubGlobal("window", {});
        vi.stubGlobal(
          "localStorage",
          failure === "unavailable"
            ? undefined
            : {
                getItem: () => null,
                setItem: () => {
                  /* Simulate a browser discarding writes. */
                },
                removeItem: () => {
                  /* No value was retained. */
                },
              },
        );
        expect(() => {
          saveCheckpoint(checkpoint);
        }).toThrow("Browser storage is unavailable");
        expect(() => {
          saveCheckpoint({ ...checkpoint, txHash: "b".repeat(64) });
        }).toThrow("previous transaction remains pending");
        vi.unstubAllGlobals();
        saveCheckpoint(null);
      },
    );

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

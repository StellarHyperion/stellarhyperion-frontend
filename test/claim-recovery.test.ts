import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Address,
  Contract,
  Keypair,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { STELLAR_DEPLOYMENT, TESTNET } from "../src/config/testnet";
import {
  resolveClaimSettlementCheckpoint,
  settleClaimsOperation,
  submitOperation,
} from "../src/contracts/stellar";
import {
  parseClaimSettlementCheckpoint,
  type ClaimSettlementCheckpoint,
} from "../src/contracts/claim-checkpoint";

const key = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(19));
const claimKey = "hyperion.testnet.pending-claim-settlement";
const identity = {
  claimId: "9007199254740993",
  recipient: key.publicKey(),
  token: TESTNET.token,
  amount: "10000001",
};
const base: ClaimSettlementCheckpoint = {
  ...identity,
  router: TESTNET.router,
  account: key.publicKey(),
  txHash: "a".repeat(64),
  chain: "stellar-testnet",
  deploymentHash: STELLAR_DEPLOYMENT.wasmHash,
};
function encoded(batch = false, successful = true) {
  const identities = batch
    ? [identity, { ...identity, claimId: "9007199254740994", amount: "20" }]
    : [identity];
  const ids = identities.map((item) => BigInt(item.claimId));
  const operation = batch
    ? settleClaimsOperation(key.publicKey(), ids)
    : new Contract(TESTNET.router).call(
        "settle_claim",
        new Address(key.publicKey()).toScVal(),
        nativeToScVal(ids[0], { type: "u64" }),
      );
  const transaction = new TransactionBuilder(new Account(key.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: TESTNET.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();
  transaction.sign(key);
  const result = new xdr.TransactionResult({
    feeCharged: 100n,
    result: successful
      ? xdr.TransactionResultResult.txSuccess([
          xdr.OperationResult.opInner(
            xdr.OperationResultTr.invokeHostFunction(
              xdr.InvokeHostFunctionResult.invokeHostFunctionSuccess(new Uint8Array(32)),
            ),
          ),
        ])
      : xdr.TransactionResultResult.txBadSeq(),
    ext: xdr.TransactionResultExt.v0(),
  });
  const checkpoint: ClaimSettlementCheckpoint = {
    ...base,
    claims: identities,
    claimId: identities.map((item) => item.claimId).join(","),
    amount: identities.reduce((sum, item) => sum + BigInt(item.amount), 0n).toString(),
    txHash: Buffer.from(transaction.hash()).toString("hex"),
  };
  const claims = identities.map((item) => ({
    ...item,
    id: BigInt(item.claimId),
    amount: BigInt(item.amount),
    settled: successful,
  }));
  const response = {
    status: successful ? rpc.Api.GetTransactionStatus.SUCCESS : rpc.Api.GetTransactionStatus.FAILED,
    txHash: checkpoint.txHash,
    latestLedger: 100,
    latestLedgerCloseTime: 100,
    oldestLedger: 90,
    oldestLedgerCloseTime: 90,
    ledger: 95,
    createdAt: 95,
    applicationOrder: 1,
    feeBump: false,
    envelopeXdr: transaction.toEnvelope(),
    resultXdr: result,
    resultMetaXdr: xdr.TransactionMeta.operations([]),
    events: { transactionEventsXdr: [], contractEventsXdr: [] },
  } as rpc.Api.GetTransactionResponse;
  return { checkpoint, claims, response };
}
function mockClaims(claims: ReturnType<typeof encoded>["claims"]) {
  vi.spyOn(rpc.Server.prototype, "getContractMethods").mockResolvedValue([]);
  vi.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(() =>
    Promise.resolve(new Account(key.publicKey(), "1")),
  );
  vi.spyOn(rpc.Server.prototype, "getContractInstance").mockResolvedValue({
    executable: {
      type: "contractExecutableWasm",
      wasmHash: Buffer.from(STELLAR_DEPLOYMENT.wasmHash, "hex"),
    },
    storage: null,
  } as never);
  vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation((transaction) => {
    const envelope = transaction.toEnvelope();
    if (envelope.type !== "envelopeTypeTx") throw new Error("Unexpected envelope");
    const operation = envelope.v1.tx.operations[0];
    if (
      operation?.body.type !== "invokeHostFunction" ||
      operation.body.invokeHostFunctionOp.hostFunction.type !== "hostFunctionTypeInvokeContract"
    )
      throw new Error("Unexpected operation");
    const args = operation.body.invokeHostFunctionOp.hostFunction.invokeContract.args;
    const id = args[0] ? (scValToNative(args[0]) as bigint) : 0n;
    const claim = claims.find((item) => item.id === id);
    return Promise.resolve({
      id: "fixture",
      latestLedger: 100,
      events: [],
      _parsed: true,
      transactionData: new SorobanDataBuilder().setResourceFee(100),
      minResourceFee: "100",
      result: { auth: [], retval: nativeToScVal(claim ?? 1n) },
    });
  });
}
beforeEach(() => {
  vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
    passphrase: TESTNET.networkPassphrase,
    protocolVersion: "27",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Independently encoded settlement and on-chain identity evidence", () => {
  for (const batch of [false, true])
    for (const successful of [false, true]) {
      it(`reconciles ${batch ? "batch" : "single"} ${successful ? "success" : "failure"} with every original identity`, async () => {
        const item = encoded(batch, successful);
        mockClaims(item.claims);
        vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(item.response);
        await expect(resolveClaimSettlementCheckpoint(item.checkpoint)).resolves.toMatchObject({
          status: successful ? "confirmed" : "failed",
        });
      });
    }
  for (const field of ["recipient", "token", "amount", "settled", "id"] as const) {
    it(`retains the checkpoint when fresh on-chain ${field} differs`, async () => {
      const item = encoded();
      const claim = item.claims[0];
      if (!claim) throw new Error("Missing fixture");
      if (field === "recipient") claim.recipient = Keypair.random().publicKey();
      if (field === "token") claim.token = TESTNET.router;
      if (field === "amount") claim.amount += 1n;
      if (field === "settled") claim.settled = false;
      if (field === "id") claim.id += 1n;
      mockClaims(item.claims);
      vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(item.response);
      const original = JSON.stringify(item.checkpoint);
      expect((await resolveClaimSettlementCheckpoint(item.checkpoint)).status).toBe("unknown");
      expect(JSON.stringify(item.checkpoint)).toBe(original);
    });
  }
  it("rejects a successful source transaction with a different saved claim call", async () => {
    const item = encoded();
    mockClaims(item.claims);
    vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(item.response);
    const changed = { ...item.checkpoint, claimId: "2", claims: [{ ...identity, claimId: "2" }] };
    expect((await resolveClaimSettlementCheckpoint(changed)).status).toBe("unknown");
  });
  it("keeps unavailable or wrong-network RPC evidence unresolved without signing", async () => {
    const item = encoded();
    const read = vi
      .spyOn(rpc.Server.prototype, "getTransaction")
      .mockRejectedValue(new Error("offline"));
    expect((await resolveClaimSettlementCheckpoint(item.checkpoint)).status).toBe("unknown");
    vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: "Public Global Stellar Network ; September 2015",
      protocolVersion: "27",
    });
    read.mockClear();
    expect((await resolveClaimSettlementCheckpoint(item.checkpoint)).status).toBe("unknown");
    expect(read).not.toHaveBeenCalled();
  });
});

describe("Bounded checkpoint storage and broadcast failure boundaries", () => {
  it("reads old single records and full-width batch identities without Number conversion", () => {
    const legacy = { ...identity, router: base.router, account: base.account, txHash: base.txHash };
    expect(parseClaimSettlementCheckpoint(JSON.stringify(legacy))?.claimId).toBe(identity.claimId);
    const batch = encoded(true).checkpoint;
    expect(parseClaimSettlementCheckpoint(JSON.stringify(batch))?.claims?.[1]?.amount).toBe("20");
    expect(parseClaimSettlementCheckpoint("x".repeat(16385))).toBeNull();
    expect(
      parseClaimSettlementCheckpoint(JSON.stringify({ ...base, amount: Number(base.amount) })),
    ).toBeNull();
    expect(
      parseClaimSettlementCheckpoint(JSON.stringify({ ...base, claimId: (1n << 64n).toString() })),
    ).toBeNull();
  });
  it("refuses overwrite and stale same-hash identity resets from another tab", async () => {
    vi.resetModules();
    const store = await import("../src/contracts/claim-checkpoint");
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (name: string) => values.get(name) ?? null,
      setItem: (name: string, value: string) => {
        values.set(name, value);
      },
      removeItem: (name: string) => {
        values.delete(name);
      },
    });
    store.saveClaimSettlementCheckpoint(base);
    expect(() => {
      store.saveClaimSettlementCheckpoint({ ...base, txHash: "b".repeat(64) });
    }).toThrow("unresolved");
    const changed = { ...base, amount: "20" };
    values.set(claimKey, JSON.stringify(changed));
    expect(() => {
      store.saveClaimSettlementCheckpoint(null, base);
    }).toThrow("preserved");
    expect(values.get(claimKey)).toBe(JSON.stringify(changed));
  });
  it("fails closed on malformed persisted records and inaccessible reads", async () => {
    vi.resetModules();
    const store = await import("../src/contracts/claim-checkpoint");
    vi.stubGlobal("localStorage", { getItem: () => "{bad JSON" });
    expect(() => store.getClaimSettlementCheckpoint()).toThrow("could not be verified");
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => store.getClaimSettlementCheckpoint()).toThrow("unavailable");
  });
  it("blocks broadcast when a store silently discards the signed hash", async () => {
    vi.resetModules();
    const store = await import("../src/contracts/claim-checkpoint");
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    mockClaims([]);
    const send = vi.spyOn(rpc.Server.prototype, "sendTransaction");
    const operation = new Contract(TESTNET.router).call(
      "settle_claim",
      new Address(key.publicKey()).toScVal(),
      nativeToScVal(1n, { type: "u64" }),
    );
    const sign = vi.fn((raw: string) => {
      const transaction = TransactionBuilder.fromXdr(raw, TESTNET.networkPassphrase);
      transaction.sign(key);
      return Promise.resolve({ signedTxXdr: transaction.toXdr() });
    });
    await expect(
      submitOperation(key.publicKey(), operation, sign, undefined, undefined, {
        expectedAccount: key.publicKey(),
        onSigned: (hash) => {
          store.saveClaimSettlementCheckpoint({ ...base, txHash: hash });
        },
      }),
    ).rejects.toThrow("not broadcast");
    expect(sign).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});

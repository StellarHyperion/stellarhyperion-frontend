import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { readTransaction, resolveCheckpointTransaction } from "../src/contracts/stellar";
import {
  getTransferCheckpoint,
  saveCheckpoint,
  type TransferCheckpoint,
} from "../src/contracts/checkpoint";
import { TESTNET } from "../src/config/testnet";
import { XLM } from "../src/contracts/assets";

const pair = Keypair.random();
const transaction = new TransactionBuilder(new Account(pair.publicKey(), "1"), {
  fee: "100",
  networkPassphrase: TESTNET.networkPassphrase,
})
  .addOperation(
    Operation.pathPaymentStrictReceive({
      sendAsset: Asset.native(),
      sendMax: "2",
      destination: pair.publicKey(),
      destAsset: new Asset(TESTNET.usdcCode, TESTNET.usdcIssuer),
      destAmount: "1",
      path: [],
    }),
  )
  .setTimeout(60)
  .build();
transaction.sign(pair);
const hash = Buffer.from(transaction.hash()).toString("hex");
const checkpoint: TransferCheckpoint = {
  router: TESTNET.router,
  account: pair.publicKey(),
  recipient: "0x" + "a".repeat(40),
  destination: "sepolia",
  route: 1,
  bridgeAmount: "10000000",
  stage: "conversion",
  txHash: hash,
  source: { id: XLM.id, code: XLM.code, issuer: XLM.issuer },
};
const successful = new xdr.TransactionResult({
  feeCharged: 100n,
  ext: xdr.TransactionResultExt.v0(),
  result: xdr.TransactionResultResult.txSuccess([
    xdr.OperationResult.opInner(
      xdr.OperationResultTr.pathPaymentStrictReceive(
        xdr.PathPaymentStrictReceiveResult.pathPaymentStrictReceiveSuccess(
          new xdr.PathPaymentStrictReceiveResultSuccess({
            offers: [],
            last: new xdr.SimplePaymentResult({
              destination: pair.xdrPublicKey(),
              asset: new Asset(TESTNET.usdcCode, TESTNET.usdcIssuer).toXdrObject(),
              amount: 10000000n,
            }),
          }),
        ),
      ),
    ),
  ]),
});
const failed = new xdr.TransactionResult({
  feeCharged: 100n,
  ext: xdr.TransactionResultExt.v0(),
  result: xdr.TransactionResultResult.txBadSeq(),
});
function response(
  status: "confirmed" | "failed" | "pending",
  nonce?: bigint,
): rpc.Api.GetTransactionResponse {
  const base = {
    txHash: hash,
    latestLedger: 100,
    latestLedgerCloseTime: 100,
    oldestLedger: 90,
    oldestLedgerCloseTime: 90,
  };
  if (status === "pending") return { ...base, status: rpc.Api.GetTransactionStatus.NOT_FOUND };
  return {
    ...base,
    status:
      status === "confirmed"
        ? rpc.Api.GetTransactionStatus.SUCCESS
        : rpc.Api.GetTransactionStatus.FAILED,
    ledger: 95,
    createdAt: 95,
    applicationOrder: 1,
    feeBump: false,
    envelopeXdr: transaction.toEnvelope(),
    resultXdr: status === "confirmed" ? successful : failed,
    resultMetaXdr: xdr.TransactionMeta.operations([]),
    events: { transactionEventsXdr: [], contractEventsXdr: [] },
    ...(nonce !== undefined ? { returnValue: nativeToScVal(nonce, { type: "u64" }) } : {}),
  };
}
function sources(
  first: rpc.Api.GetTransactionResponse,
  second: rpc.Api.GetTransactionResponse | Error,
) {
  return vi.spyOn(rpc.Server.prototype, "getTransaction").mockImplementation(function (
    this: rpc.Server,
  ) {
    if (this.serverURL.hostname === "second.example")
      return second instanceof Error ? Promise.reject(second) : Promise.resolve(second);
    return Promise.resolve(first);
  });
}
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_STELLAR_READ_RPC_URLS", "https://second.example/rpc");
  vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
    passphrase: TESTNET.networkPassphrase,
    protocolVersion: "27",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("Bounded source RPC consensus", () => {
  for (const status of ["confirmed", "failed", "pending"] as const) {
    it(`accepts matching ${status} evidence from two network-verified sources`, async () => {
      const reads = sources(response(status), response(status));
      await expect(readTransaction(hash)).resolves.toMatchObject({ status, txHash: hash });
      expect(reads).toHaveBeenCalledTimes(2);
    });
  }
  for (const second of [response("failed"), response("pending"), new Error("offline")]) {
    it("keeps disagreement or missing source evidence pending", async () => {
      sources(response("confirmed"), second);
      await expect(readTransaction(hash)).resolves.toMatchObject({
        status: "pending",
        txHash: hash,
      });
      expect((await readTransaction(hash))?.reason).toMatch(/unknown/);
    });
  }
  it("blocks conflicting or missing return values as well as statuses", async () => {
    sources(response("confirmed", 1n), response("confirmed", 2n));
    await expect(readTransaction(hash)).resolves.toMatchObject({ status: "pending" });
    sources(response("confirmed", 1n), response("confirmed"));
    await expect(readTransaction(hash)).resolves.toMatchObject({ status: "pending" });
  });
  it("checks every source network and refuses a mainnet result", async () => {
    const network = vi.spyOn(rpc.Server.prototype, "getNetwork").mockImplementation(function (
      this: rpc.Server,
    ) {
      return Promise.resolve({
        passphrase:
          this.serverURL.hostname === "second.example"
            ? "Public Global Stellar Network ; September 2015"
            : TESTNET.networkPassphrase,
        protocolVersion: "27",
      });
    });
    sources(response("confirmed"), response("confirmed"));
    await expect(readTransaction(hash)).resolves.toMatchObject({ status: "pending" });
    expect(network).toHaveBeenCalledTimes(2);
  });
  it("rejects a matching status with another signed hash", async () => {
    const other = response("confirmed");
    other.txHash = "b".repeat(64);
    sources(response("confirmed"), other);
    await expect(readTransaction(hash)).resolves.toMatchObject({ status: "pending" });
  });
  it("deduplicates origins and caps the total at three sources", async () => {
    vi.stubEnv(
      "NEXT_PUBLIC_STELLAR_READ_RPC_URLS",
      `${TESTNET.rpcUrl}/other,https://second.example/rpc,https://second.example/another,https://third.example,https://fourth.example`,
    );
    const network = vi.spyOn(rpc.Server.prototype, "getNetwork");
    const reads = vi
      .spyOn(rpc.Server.prototype, "getTransaction")
      .mockResolvedValue(response("pending"));
    await expect(readTransaction(hash)).resolves.toMatchObject({ status: "pending" });
    expect(reads).toHaveBeenCalledTimes(3);
    expect(network).toHaveBeenCalledTimes(3);
  });
  it("bounds stalled reads and cancels all waiting sources", async () => {
    const controller = new AbortController();
    vi.spyOn(rpc.Server.prototype, "getTransaction").mockImplementation(
      () =>
        new Promise(() => {
          /* Deliberately stalled RPC read. */
        }),
    );
    const result = readTransaction(hash, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
  it("never lets agreeing historical success override conflicting RPC evidence", async () => {
    sources(response("confirmed"), response("failed"));
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(resolveCheckpointTransaction(checkpoint)).resolves.toMatchObject({
      status: "unknown",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("checks independent historical evidence when all RPC histories are absent", async () => {
    sources(response("pending"), response("pending"));
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url === TESTNET.horizonUrl
            ? Response.json({ network_passphrase: TESTNET.networkPassphrase })
            : Response.json({
                hash,
                source_account: pair.publicKey(),
                successful: true,
                envelope_xdr: transaction.toXdr(),
                result_xdr: successful.toXdr("base64"),
              }),
        ),
      ),
    );
    await expect(resolveCheckpointTransaction(checkpoint)).resolves.toMatchObject({
      status: "confirmed",
      source: "horizon",
    });
  });
  it("does not broadcast or change stored recovery while reading ambiguity", async () => {
    sources(response("confirmed"), response("failed"));
    const broadcast = vi.spyOn(rpc.Server.prototype, "sendTransaction");
    const storage = {
      getItem: vi.fn(() => JSON.stringify(checkpoint)),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    vi.stubGlobal("localStorage", storage);
    await expect(readTransaction(hash)).resolves.toMatchObject({ status: "pending" });
    await expect(resolveCheckpointTransaction(checkpoint)).resolves.toMatchObject({
      status: "unknown",
    });
    expect(broadcast).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
});
describe("Checkpoint reset compares the complete saved intent", () => {
  it("cannot clear a same-hash checkpoint whose account or amount changed", () => {
    const actual = { ...checkpoint, bridgeAmount: "20000000" };
    const storage = {
      getItem: () => JSON.stringify(actual),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    vi.stubGlobal("localStorage", storage);
    expect(getTransferCheckpoint()).toMatchObject(actual);
    expect(() => {
      saveCheckpoint(null, checkpoint);
    }).toThrow(/changed in another tab/);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
  it("clears only the exact reviewed checkpoint", () => {
    const values = new Map([["hyperion.testnet.pending-transfer", JSON.stringify(checkpoint)]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    });
    saveCheckpoint(null, checkpoint);
    expect(values.has("hyperion.testnet.pending-transfer")).toBe(false);
  });
});

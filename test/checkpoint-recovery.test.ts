import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  bridgeOperation,
  resolveCheckpointTransaction,
  type LiveQuote,
} from "../src/contracts/stellar";
import { USDC, XLM, requireRecoveredUsdc } from "../src/contracts/assets";
import { type TransferCheckpoint } from "../src/contracts/checkpoint";
import { TESTNET } from "../src/config/testnet";

const account = Keypair.random();
const recipient = "0x" + "a".repeat(40);
const quote: LiveQuote = {
  route: 1,
  adapter: TESTNET.router,
  destination: "sepolia",
  requestedAmount: 10000000n,
  grossAmount: 10000000n,
  fee: 30000n,
  netAmount: 9970000n,
  destinationAmount: 9970000n,
  representableAmount: 9970000n,
  flowAvailable: 10000000000n,
  ledger: 1,
  relayGas: 1051082n,
};
function fixture(stage: TransferCheckpoint["stage"], successful = true) {
  const operation =
    stage === "conversion"
      ? Operation.pathPaymentStrictReceive({
          sendAsset: Asset.native(),
          sendMax: "2",
          destination: account.publicKey(),
          destAsset: new Asset(TESTNET.usdcCode, TESTNET.usdcIssuer),
          destAmount: "1",
          path: [],
        })
      : bridgeOperation(account.publicKey(), quote, recipient);
  const transaction = new TransactionBuilder(new Account(account.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: TESTNET.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();
  transaction.sign(account);
  const checkpoint: TransferCheckpoint = {
    router: TESTNET.router,
    account: account.publicKey(),
    recipient,
    destination: "sepolia",
    route: 1,
    bridgeAmount: "10000000",
    stage,
    txHash: Buffer.from(transaction.hash()).toString("hex"),
  };
  const result = new xdr.TransactionResult({
    feeCharged: 100n,
    result: successful
      ? xdr.TransactionResultResult.txSuccess([
          xdr.OperationResult.opInner(
            stage === "conversion"
              ? xdr.OperationResultTr.pathPaymentStrictReceive(
                  xdr.PathPaymentStrictReceiveResult.pathPaymentStrictReceiveSuccess(
                    new xdr.PathPaymentStrictReceiveResultSuccess({ offers: [], last: payment() }),
                  ),
                )
              : xdr.OperationResultTr.invokeHostFunction(
                  xdr.InvokeHostFunctionResult.invokeHostFunctionSuccess(new Uint8Array(32)),
                ),
          ),
        ])
      : xdr.TransactionResultResult.txBadSeq(),
    ext: xdr.TransactionResultExt.v0(),
  });
  return { checkpoint, transaction, result };
}
function payment(
  amount = 10000000n,
  destination = account.publicKey(),
  issuer = TESTNET.usdcIssuer,
) {
  return new xdr.SimplePaymentResult({
    destination: Keypair.fromPublicKey(destination).xdrPublicKey(),
    asset: new Asset(TESTNET.usdcCode, issuer).toXdrObject(),
    amount,
  });
}
const history = (item: ReturnType<typeof fixture>, successful = true) => ({
  hash: item.checkpoint.txHash,
  source_account: item.checkpoint.account,
  successful,
  envelope_xdr: item.transaction.toXdr(),
  result_xdr: item.result.toXdr("base64"),
});
function mockHistory(body: unknown, status = 200, network: string = TESTNET.networkPassphrase) {
  const fetcher = vi.fn((url: string | URL | Request) =>
    Promise.resolve(
      (typeof url === "string" ? url : url instanceof URL ? url.href : url.url) ===
        TESTNET.horizonUrl
        ? Response.json({ network_passphrase: network })
        : Response.json(body, { status }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
describe("conversion source asset binding", () => {
  it("checks the source against independent envelope evidence while retaining the signed hash", async () => {
    const item = fixture("conversion");
    item.checkpoint.source = { id: XLM.id, code: XLM.code, issuer: XLM.issuer };
    mockHistory(history(item));
    expect((await resolveCheckpointTransaction(item.checkpoint)).status).toBe("confirmed");
    const rebound = {
      ...item.checkpoint,
      source: { id: USDC.id, code: USDC.code, issuer: USDC.issuer },
    };
    expect((await resolveCheckpointTransaction(rebound)).status).toBe("unknown");
    expect(rebound.txHash).toBe(item.checkpoint.txHash);
  });
});

beforeEach(() => {
  vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
    passphrase: TESTNET.networkPassphrase,
    protocolVersion: "27",
  });
  vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue({
    status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    txHash: "0".repeat(64),
    latestLedger: 100,
    latestLedgerCloseTime: 100,
    oldestLedger: 90,
    oldestLedgerCloseTime: 90,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Checkpoint recovery from independently encoded transaction evidence", () => {
  for (const stage of ["conversion", "bridge"] as const) {
    for (const successful of [true, false]) {
      it(`recovers expired ${stage} history as ${successful ? "confirmed" : "failed"}`, async () => {
        const item = fixture(stage, successful);
        mockHistory(history(item, successful));
        await expect(resolveCheckpointTransaction(item.checkpoint)).resolves.toMatchObject({
          status: successful ? "confirmed" : "failed",
          source: "horizon",
        });
      });
    }
    it(`uses parsed RPC XDR for ${stage} before historical fallback`, async () => {
      const item = fixture(stage);
      vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        txHash: item.checkpoint.txHash,
        latestLedger: 100,
        latestLedgerCloseTime: 100,
        oldestLedger: 90,
        oldestLedgerCloseTime: 90,
        ledger: 95,
        createdAt: 95,
        applicationOrder: 1,
        feeBump: false,
        envelopeXdr: item.transaction.toEnvelope(),
        resultXdr: item.result,
        resultMetaXdr: xdr.TransactionMeta.operations([]),
        events: { transactionEventsXdr: [], contractEventsXdr: [] },
      });
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      await expect(resolveCheckpointTransaction(item.checkpoint)).resolves.toMatchObject({
        status: "confirmed",
        source: "rpc",
      });
      expect(fetcher).not.toHaveBeenCalled();
    });
  }
  for (const field of [
    "account",
    "recipient",
    "route",
    "destination",
    "bridgeAmount",
    "router",
    "txHash",
  ] as const) {
    it(`keeps a conflicting ${field} unknown`, async () => {
      const item = fixture("bridge");
      mockHistory(history(item));
      const checkpoint = { ...item.checkpoint };
      switch (field) {
        case "account":
          checkpoint.account = Keypair.random().publicKey();
          break;
        case "recipient":
          checkpoint.recipient = "0x" + "b".repeat(40);
          break;
        case "route":
          checkpoint.route = 0;
          break;
        case "destination":
          checkpoint.destination = "base-sepolia";
          break;
        case "bridgeAmount":
          checkpoint.bridgeAmount = "2";
          break;
        case "router":
          checkpoint.router = Keypair.random().publicKey();
          break;
        case "txHash":
          checkpoint.txHash = "a".repeat(64);
          break;
      }
      await expect(resolveCheckpointTransaction(checkpoint)).resolves.toMatchObject({
        status: "unknown",
      });
    });
  }
  for (const last of [
    payment(1n),
    payment(10000000n, Keypair.random().publicKey()),
    payment(10000000n, account.publicKey(), Keypair.random().publicKey()),
  ]) {
    it("rejects txSuccess when the conversion result payment conflicts", async () => {
      const item = fixture("conversion");
      const result = new xdr.TransactionResult({
        feeCharged: 100n,
        ext: xdr.TransactionResultExt.v0(),
        result: xdr.TransactionResultResult.txSuccess([
          xdr.OperationResult.opInner(
            xdr.OperationResultTr.pathPaymentStrictReceive(
              xdr.PathPaymentStrictReceiveResult.pathPaymentStrictReceiveSuccess(
                new xdr.PathPaymentStrictReceiveResultSuccess({ offers: [], last }),
              ),
            ),
          ),
        ]),
      });
      mockHistory({ ...history(item), result_xdr: result.toXdr("base64") });
      await expect(resolveCheckpointTransaction(item.checkpoint)).resolves.toMatchObject({
        status: "unknown",
      });
    });
  }
  it("keeps absent history and contradictory success flags unknown", async () => {
    const item = fixture("bridge");
    mockHistory({}, 404);
    await expect(resolveCheckpointTransaction(item.checkpoint)).resolves.toMatchObject({
      status: "unknown",
    });
    mockHistory(history(item, false));
    await expect(resolveCheckpointTransaction(item.checkpoint)).resolves.toMatchObject({
      status: "unknown",
    });
  });
  it("rejects network mismatches before applying RPC or historical evidence", async () => {
    const item = fixture("conversion");
    mockHistory(history(item), 200, "wrong network");
    await expect(resolveCheckpointTransaction(item.checkpoint)).resolves.toMatchObject({
      status: "unknown",
    });
    vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
      passphrase: "wrong",
      protocolVersion: "27",
    });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(resolveCheckpointTransaction(item.checkpoint)).resolves.toMatchObject({
      status: "unknown",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("bounds streamed history without trusting Content-Length", async () => {
    const item = fixture("bridge");
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url === TESTNET.horizonUrl
            ? Response.json({ network_passphrase: TESTNET.networkPassphrase })
            : new Response("x".repeat(512001)),
        ),
      ),
    );
    await expect(resolveCheckpointTransaction(item.checkpoint)).resolves.toMatchObject({
      status: "unknown",
    });
  });
  it("cancels a stuck RPC read and ignores its late successful response", async () => {
    const item = fixture("bridge");
    const controller = new AbortController();
    vi.spyOn(rpc.Server.prototype, "getTransaction").mockImplementation(
      () =>
        new Promise(() => {
          /* This RPC fixture deliberately never resolves. */
        }),
    );
    const pending = resolveCheckpointTransaction(item.checkpoint, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
  it("keeps provider outages and malformed evidence unknown without writes", async () => {
    const item = fixture("conversion");
    const storage = { setItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal("localStorage", storage);
    mockHistory({ ...history(item), envelope_xdr: "malformed" });
    await expect(resolveCheckpointTransaction(item.checkpoint)).resolves.toMatchObject({
      status: "unknown",
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(resolveCheckpointTransaction(item.checkpoint)).resolves.toMatchObject({
      status: "unknown",
    });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
});
describe("Recovered USDC must still be spendable", () => {
  for (const extra of [
    { selling_liabilities: "0.5" },
    { is_authorized: false },
    { is_authorized_to_maintain_liabilities: true, is_authorized: false },
  ]) {
    it("blocks insufficient or unauthorized canonical USDC despite total balance", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          Response.json({
            balances: [
              {
                asset_type: "credit_alphanum4",
                asset_code: TESTNET.usdcCode,
                asset_issuer: TESTNET.usdcIssuer,
                balance: "1",
                ...extra,
              },
            ],
          }),
        ),
      );
      await expect(requireRecoveredUsdc(account.publicKey(), 10000000n)).rejects.toThrow(
        /not currently available/,
      );
    });
  }
  it("accepts authorized spendable canonical USDC", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          balances: [
            {
              asset_type: "credit_alphanum4",
              asset_code: TESTNET.usdcCode,
              asset_issuer: TESTNET.usdcIssuer,
              balance: "1",
              selling_liabilities: "0",
              is_authorized: true,
            },
          ],
        }),
      ),
    );
    await expect(requireRecoveredUsdc(account.publicKey(), 10000000n)).resolves.toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Keypair,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  type xdr,
} from "@stellar/stellar-sdk";
import { toHex } from "@hyperion/protocol";
import { quoteBreakdown, submitSettleClaim, type LiveQuote } from "../src/contracts/stellar";
import { STELLAR_DEPLOYMENT, TESTNET } from "../src/config/testnet";

// Deterministic test-only signer; this test never connects to a network.
const key = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(7));
const success = (retval: xdr.ScVal): rpc.Api.SimulateTransactionSuccessResponse => ({
  id: "test",
  latestLedger: 1,
  events: [],
  _parsed: true,
  transactionData: new SorobanDataBuilder(),
  minResourceFee: "100",
  result: { auth: [], retval },
});
function setup() {
  vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
    passphrase: TESTNET.networkPassphrase,
    protocolVersion: "27",
  });
  vi.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(key.publicKey(), "0"));
  vi.spyOn(rpc.Server.prototype, "getContractInstance").mockResolvedValue({
    executable: {
      type: "contractExecutableWasm",
      wasmHash: Uint8Array.from({ length: 32 }, (_, index) =>
        parseInt(STELLAR_DEPLOYMENT.wasmHash.slice(index * 2, index * 2 + 2), 16),
      ),
    },
    storage: null,
  } as never);
  const simulation = vi.spyOn(rpc.Server.prototype, "simulateTransaction");
  simulation.mockResolvedValueOnce(
    success(
      nativeToScVal({
        id: 1n,
        recipient: key.publicKey(),
        token: TESTNET.token,
        amount: 10n,
        settled: false,
      }),
    ),
  );
  simulation.mockResolvedValue(success(nativeToScVal(1n)));
  const send = vi.spyOn(rpc.Server.prototype, "sendTransaction");
  return { simulation, send };
}
const sign = (value: string) => {
  const tx = TransactionBuilder.fromXdr(value, TESTNET.networkPassphrase);
  tx.sign(key);
  return Promise.resolve({ signedTxXdr: tx.toXdr() });
};
afterEach(() => vi.restoreAllMocks());

describe("Signed Stellar submission failure boundaries", () => {
  it("recovers the exact precision dust a CCTP route's six-decimal destination truncates", () => {
    // 7-decimal Stellar USDC minus the fee leaves 9,969,995 base units -- not a multiple of
    // the 10-unit quantum that six-decimal Circle USDC can represent, so the trailing 5 base
    // units (0.0000005 USDC) are dust: debited on Stellar, never representable at the
    // destination, and never bridged.
    const value: LiveQuote = {
      route: 0,
      adapter: TESTNET.router,
      destination: "sepolia",
      requestedAmount: 10000000n,
      grossAmount: 10000000n,
      fee: 30005n,
      netAmount: 9969995n,
      representableAmount: 996999n,
      destinationAmount: 946999n,
      flowAvailable: 10000000000n,
      ledger: 1,
      relayGas: 500000n,
    };
    expect(quoteBreakdown(value)).toEqual({
      requestedSourceAmount: 10000000n,
      protocolFee: 30005n,
      representableBridgeAmount: 9969990n,
      retainedDust: 5n,
    });
  });
  it("retains no dust on Axelar ITS, whose seven-decimal destination matches Stellar exactly", () => {
    const value: LiveQuote = {
      route: 1,
      adapter: TESTNET.router,
      destination: "sepolia",
      requestedAmount: 10000009n,
      grossAmount: 10000009n,
      fee: 30000n,
      netAmount: 9970009n,
      representableAmount: 9970009n,
      destinationAmount: 9970009n,
      flowAvailable: 10000000000n,
      ledger: 1,
      relayGas: 1051082n,
    };
    expect(quoteBreakdown(value)).toEqual({
      requestedSourceAmount: 10000009n,
      protocolFee: 30000n,
      representableBridgeAmount: 9970009n,
      retainedDust: 0n,
    });
  });

  it("never asks the wallet or submits when simulation fails", async () => {
    const { simulation, send } = setup();
    simulation.mockResolvedValueOnce({
      id: "test",
      latestLedger: 1,
      _parsed: true,
      events: [],
      error: "contract refused",
    });
    const wallet = vi.fn(sign);
    await expect(submitSettleClaim(key.publicKey(), 1n, wallet)).rejects.toThrow(
      "contract refused",
    );
    expect(wallet).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it("never submits a declined wallet signature", async () => {
    const { send } = setup();
    await expect(
      submitSettleClaim(key.publicKey(), 1n, () => Promise.reject(new Error("declined"))),
    ).rejects.toThrow("declined");
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects a wallet response that changes the prepared transaction", async () => {
    const { send } = setup();
    const changed = (value: string) => {
      const tx = TransactionBuilder.fromXdr(value, TESTNET.networkPassphrase);
      if ("innerTransaction" in tx) throw new Error("Unexpected fee bump");
      return Promise.resolve({
        signedTxXdr: TransactionBuilder.cloneFrom(tx, { fee: "9999" }).build().toXdr(),
      });
    };
    await expect(submitSettleClaim(key.publicKey(), 1n, changed)).rejects.toThrow(
      "different transaction",
    );
    expect(send).not.toHaveBeenCalled();
  });
  it("preserves the actual signed hash when submission times out", async () => {
    const { send } = setup();
    let hash: string | undefined;
    send.mockImplementation((tx) => {
      hash = toHex(tx.hash()).slice(2);
      return Promise.reject(new Error("timeout"));
    });
    const result = await submitSettleClaim(key.publicKey(), 1n, sign);
    expect(result).toEqual({ status: "pending", txHash: hash });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("reports a known network rejection instead of source confirmation", async () => {
    const { send } = setup();
    send.mockResolvedValue({
      status: "ERROR",
      hash: "a".repeat(64),
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    });
    await expect(submitSettleClaim(key.publicKey(), 1n, sign)).rejects.toThrow("network rejected");
  });
});

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
import { archivedRouterFor } from "../src/config/testnet";
import {
  readCheckpointTransaction,
  readTransaction,
  submitSettleClaim,
} from "../src/contracts/stellar";
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
  vi.spyOn(rpc.Server.prototype, "getContractMethods").mockResolvedValue([]);
  vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
    passphrase: TESTNET.networkPassphrase,
    protocolVersion: "27",
  });
  vi.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(() =>
    Promise.resolve(new Account(key.publicKey(), "0")),
  );
  const getContractInstance = vi
    .spyOn(rpc.Server.prototype, "getContractInstance")
    .mockResolvedValue({
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
  return { simulation, send, getContractInstance };
}
const sign = (value: string) => {
  const tx = TransactionBuilder.fromXdr(value, TESTNET.networkPassphrase);
  tx.sign(key);
  return Promise.resolve({ signedTxXdr: tx.toXdr() });
};
afterEach(() => vi.restoreAllMocks());

describe("Signed Stellar submission failure boundaries", () => {
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
  it("never broadcasts again while checking an ambiguous signed transaction", async () => {
    const { send } = setup();
    send.mockRejectedValue(new Error("timeout"));
    const first = await submitSettleClaim(key.publicKey(), 1n, sign);
    expect(first.status).toBe("pending");
    vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    } as never);
    expect(await readTransaction(first.txHash)).toMatchObject({ status: "pending" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("checks an archived transaction hash without reading the successor router", async () => {
    const { send, getContractInstance } = setup();
    const archived = archivedRouterFor("CDMOLDF4SJDEDRWTDF7XAYMSRE6L3YEHHIRF57CFWNQYNC6ZOZ5LWCWF");
    if (!archived) throw new Error("Expected archived testnet router metadata.");
    vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    } as never);
    const result = await readCheckpointTransaction(archived.router, "c".repeat(64));
    expect(result).toMatchObject({ status: "pending", txHash: "c".repeat(64) });
    expect(getContractInstance).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
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
  it("never automatically submits a signature for a superseded review", async () => {
    const { send } = setup();
    let superseded = false;
    const wallet = (value: string) => {
      superseded = true;
      return sign(value);
    };
    await expect(
      submitSettleClaim(key.publicKey(), 1n, wallet, undefined, {
        expectedAccount: key.publicKey(),
        isSuperseded: () => superseded,
      }),
    ).rejects.toThrow("superseded");
    expect(send).not.toHaveBeenCalled();
  });
  it("preserves exact signed hash and safe recovery state when account switches during signing", async () => {
    const { send } = setup();
    let activeAccount = key.publicKey();
    const switchedAccount = Keypair.random().publicKey();
    let recoveredHash: string | undefined;
    const wallet = (value: string) => {
      activeAccount = switchedAccount;
      return sign(value);
    };
    await expect(
      submitSettleClaim(key.publicKey(), 1n, wallet, undefined, {
        expectedAccount: key.publicKey(),
        getCurrentAccount: () => activeAccount,
        onAccountSwitch: (hash) => {
          recoveredHash = hash;
        },
      }),
    ).rejects.toThrow("switched");
    expect(send).not.toHaveBeenCalled();
    expect(recoveredHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("detects account sequence change after construction and requires fresh simulation before signing", async () => {
    const { send } = setup();
    let calls = 0;
    vi.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(() => {
      calls += 1;
      return Promise.resolve(new Account(key.publicKey(), calls > 1 ? "1" : "0"));
    });
    const wallet = vi.fn(sign);
    await expect(submitSettleClaim(key.publicKey(), 1n, wallet)).rejects.toThrow(
      "sequence changed",
    );
    expect(wallet).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it("refuses to submit an envelope with a silently altered sequence number", async () => {
    const { send } = setup();
    const altered = (value: string) => {
      const tx = TransactionBuilder.fromXdr(value, TESTNET.networkPassphrase);
      if ("innerTransaction" in tx) throw new Error("Unexpected fee bump");
      (tx as unknown as { _tx: { seqNum: bigint }; _sequence: string })._tx.seqNum = 999n;
      (tx as unknown as { _sequence: string })._sequence = "999";
      tx.sign(key);
      return Promise.resolve({ signedTxXdr: tx.toXdr() });
    };
    await expect(submitSettleClaim(key.publicKey(), 1n, altered)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it("does not broadcast after the wallet disconnects while signing", async () => {
    const { send } = setup();
    let account: string | null = key.publicKey();
    const wallet = (value: string) => {
      account = null;
      return sign(value);
    };
    await expect(
      submitSettleClaim(key.publicKey(), 1n, wallet, undefined, {
        expectedAccount: key.publicKey(),
        getCurrentAccount: () => account,
      }),
    ).rejects.toThrow("switched");
    expect(send).not.toHaveBeenCalled();
  });
});

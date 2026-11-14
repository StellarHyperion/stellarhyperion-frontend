import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Address,
  Keypair,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  type xdr,
} from "@stellar/stellar-sdk";
import { toHex } from "@hyperion/protocol";
import {
  quoteTransfer,
  resetClientFeeQuotes,
  submitBridgeOut,
  submitSettleClaim,
  type LiveQuote,
} from "../src/contracts/stellar";
import { TESTNET, destinationFor } from "../src/config/testnet";

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
afterEach(() => {
  resetClientFeeQuotes();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
  it("coalesces client fee reads across concurrent quotes and re-verifies live pricing before wallet signing", async () => {
    const sepolia = destinationFor("sepolia");
    vi.spyOn(rpc.Server.prototype, "getContractMethods").mockResolvedValue([
      { name: "dispatch_from" },
      { name: "supports_paid_route" },
    ] as unknown as Awaited<ReturnType<rpc.Server["getContractMethods"]>>);
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation((tx) => {
      const op = tx.operations[0];
      const fn =
        op?.type === "invokeHostFunction" && op.func.type === "hostFunctionTypeInvokeContract"
          ? op.func.invokeContract.functionName.toString()
          : "";
      if (fn === "get_config") {
        const contractId =
          op?.type === "invokeHostFunction" && op.func.type === "hostFunctionTypeInvokeContract"
            ? Address.fromScAddress(op.func.invokeContract.contractAddress).toString()
            : "";
        if (contractId === TESTNET.router) {
          return Promise.resolve(success(nativeToScVal({ fee_bps: 30, paused: false })));
        }
        return Promise.resolve(
          success(
            nativeToScVal({
              router: TESTNET.router,
              token_messenger: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
              message_transmitter: "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY",
              min_finality_threshold: nativeToScVal(2000, { type: "u32" }),
            }),
          ),
        );
      }
      if (fn === "get_token") {
        return Promise.resolve(success(nativeToScVal({ enabled: true })));
      }
      if (fn === "is_route_enabled") {
        return Promise.resolve(success(nativeToScVal(true)));
      }
      if (fn === "get_adapter") {
        return Promise.resolve(success(nativeToScVal(TESTNET.token)));
      }
      if (fn === "get_link") {
        return Promise.resolve(
          success(nativeToScVal({ chain: "sepolia", destination_caller: new Uint8Array(32) })),
        );
      }
      if (fn === "paused") {
        return Promise.resolve(success(nativeToScVal(false)));
      }
      if (fn === "get_remote_token_messenger") {
        const padded = `0x${sepolia.messenger.slice(2).padStart(64, "0")}`;
        const bytes = Uint8Array.from(
          (padded.slice(2).match(/.{2}/g) ?? []).map((b) => Number.parseInt(b, 16)),
        );
        return Promise.resolve(success(nativeToScVal(bytes)));
      }
      if (fn === "quote_routes") {
        return Promise.resolve(
          success(
            nativeToScVal([
              {
                route: nativeToScVal(0, { type: "u32" }),
                available: true,
                gross_amount: 10_000_000n,
                fee: 30_000n,
                net_amount: 9_970_000n,
                destination_amount: 997_000n,
                flow_available: 50_000_000n,
              },
            ]),
          ),
        );
      }
      return Promise.resolve(success(nativeToScVal(100_000_000n)));
    });

    let feeCalls = 0;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("http")) {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
          id?: number;
          method?: string;
        };
        if (body.method === "eth_chainId") {
          return Promise.resolve(
            new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: "0xaa36a7" })),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? 1,
              result: `0x${"0".repeat(62)}06`,
            }),
          ),
        );
      }
      feeCalls += 1;
      const estimated = feeCalls === 1 ? "500000" : "900000";
      const budgeted = feeCalls === 1 ? "550000" : "990000";
      return Promise.resolve(
        new Response(
          JSON.stringify({
            amount: budgeted,
            estimatedAmount: estimated,
            token: TESTNET.usdcCode,
            issuer: TESTNET.usdcIssuer,
            decimals: 7,
            finality: 2000,
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal("fetch", fetcher);

    const cancelFirst = new AbortController();
    const firstQuote = quoteTransfer("sepolia", 10_000_000n, 0, cancelFirst.signal);
    const secondQuote = quoteTransfer("sepolia", 10_000_000n, 0);
    cancelFirst.abort();

    await expect(firstQuote).rejects.toThrow();
    const quoted: LiveQuote = await secondQuote;
    expect(quoted.relayGas).toBe(550_000n);
    expect(feeCalls).toBe(1);

    // Pre-signing refresh bypasses the short cache, detects higher live gas, and never invokes wallet.
    const wallet = vi.fn(sign);
    await expect(
      submitBridgeOut(
        key.publicKey(),
        quoted,
        "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        wallet,
      ),
    ).rejects.toThrow("quote changed");
    expect(feeCalls).toBe(2);
    expect(wallet).not.toHaveBeenCalled();
  });
});

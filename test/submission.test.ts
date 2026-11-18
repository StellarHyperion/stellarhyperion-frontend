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
import { submitSettleClaim } from "../src/contracts/stellar";
import { parseBridgeFormParams } from "../src/components/bridge/Bridge";
import { USDC, XLM } from "../src/contracts/assets";
import { checkpointMatches, parseCheckpoint } from "../src/contracts/checkpoint";
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
  it("stops polling on abort without resubmitting or clearing the signed hash", async () => {
    const { send } = setup();
    send.mockResolvedValue({
      status: "SUCCESS" as rpc.Api.SendTransactionStatus,
      hash: "0x" + "0".repeat(64),
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    });
    const controller = new AbortController();
    const promise = submitSettleClaim(key.publicKey(), 1n, sign, undefined, controller.signal);
    // Allow the signed transaction to be broadcast so polling begins.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(send).toHaveBeenCalledTimes(1);
    controller.abort();
    const result = await promise;
    expect(result.status).toBe("pending");
    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);
    // Aborting polling never resubmits and preserves the real signed hash.
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("Bridge form URL state", () => {
  const recipient = "0x" + "1".repeat(40);

  it("parses a complete bounded link into form params", () => {
    const state = parseBridgeFormParams(`?a=1.5&r=${recipient}&d=sepolia&t=0&s=native`);
    expect(state).toEqual({
      amount: "1.5",
      recipient,
      destination: "sepolia",
      route: 0,
      source: XLM,
    });
  });
  it("defaults missing fields to the configured form defaults", () => {
    const state = parseBridgeFormParams("");
    expect(state).toEqual({
      amount: "",
      recipient: "",
      destination: "sepolia",
      route: 1,
      source: USDC,
    });
  });
  it("keeps only bounded keys and ignores extra query parameters", () => {
    const state = parseBridgeFormParams(
      `?a=1&r=${recipient}&d=base-sepolia&t=1&s=native&utm_source=email&checkpoint=abc&signature=x`,
    );
    expect(state).toEqual({
      amount: "1",
      recipient,
      destination: "base-sepolia",
      route: 1,
      source: XLM,
    });
  });
  it("rejects an unsupported destination", () => {
    expect(parseBridgeFormParams(`?a=1&r=${recipient}&d=ethereum&t=1&s=native`)).toBeNull();
  });
  it("rejects a malformed route", () => {
    expect(parseBridgeFormParams(`?a=1&r=${recipient}&d=sepolia&t=2&s=native`)).toBeNull();
    expect(parseBridgeFormParams(`?a=1&r=${recipient}&d=sepolia&t=abc&s=native`)).toBeNull();
  });
  it("rejects a malformed issuer-specific source", () => {
    expect(parseBridgeFormParams(`?a=1&r=${recipient}&d=sepolia&t=1&s=FOO`)).toBeNull();
    expect(parseBridgeFormParams(`?a=1&r=${recipient}&d=sepolia&t=1&s=FOO:invalid`)).toBeNull();
    expect(
      parseBridgeFormParams(`?a=1&r=${recipient}&d=sepolia&t=1&s=${"A".repeat(13)}:invalid`),
    ).toBeNull();
  });
  it("accepts native and configured sources", () => {
    expect(parseBridgeFormParams(`?a=1&r=${recipient}&d=sepolia&t=1&s=native`)?.source).toBe(XLM);
    expect(
      parseBridgeFormParams(`?a=1&r=${recipient}&d=sepolia&t=1&s=USDC:${USDC.issuer}`)?.source,
    ).toEqual(USDC);
  });
  it("accepts an issuer-specific token with validated identity", () => {
    const state = parseBridgeFormParams(`?a=1&r=${recipient}&d=sepolia&t=1&s=FOO:${USDC.issuer}`);
    if (!state) throw new Error("Expected the issuer-specific source to parse.");
    expect(state.source.id).toBe(`FOO:${USDC.issuer}`);
    expect(state.source.code).toBe("FOO");
    expect(state.source.issuer).toBe(USDC.issuer);
    expect(state.source.verification).toBe("horizon-search");
  });
});

describe("Checkpoint staleness guards", () => {
  const checkpoint: Parameters<typeof checkpointMatches>[0] = {
    router: TESTNET.router,
    account: "GA7QYNF7SOW3ZGLRZLGI5KW3TCAV6KUSUZEUYVJO6FVJWYNSVAE25E4U",
    recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    destination: "sepolia",
    route: 1,
    bridgeAmount: "10000000",
    stage: "bridge",
    txHash: "0".repeat(64),
  };
  const sameIntent = {
    account: checkpoint.account,
    destination: checkpoint.destination,
    route: checkpoint.route,
    bridgeAmount: checkpoint.bridgeAmount,
    stage: checkpoint.stage,
  };

  it("applies a confirmation only when account and intent still match", () => {
    expect(checkpointMatches(checkpoint, sameIntent)).toBe(true);
  });
  it("rejects a stale confirmation when the account changed", () => {
    expect(
      checkpointMatches(checkpoint, { ...sameIntent, account: "GDIFFERENTACCOUNT12345678901234" }),
    ).toBe(false);
  });
  it("rejects a stale confirmation when the destination changed", () => {
    expect(checkpointMatches(checkpoint, { ...sameIntent, destination: "base-sepolia" })).toBe(
      false,
    );
  });
  it("rejects a stale confirmation when the route changed", () => {
    expect(checkpointMatches(checkpoint, { ...sameIntent, route: 0 })).toBe(false);
  });
  it("rejects a stale confirmation when the amount changed", () => {
    expect(checkpointMatches(checkpoint, { ...sameIntent, bridgeAmount: "20000000" })).toBe(false);
  });
  it("rejects a stale confirmation when the stage changed", () => {
    expect(checkpointMatches(checkpoint, { ...sameIntent, stage: "conversion" })).toBe(false);
  });
});

describe("Source identity and explorer access", () => {
  const validAccount = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(8)).publicKey();
  const realHash = "a".repeat(64);
  const baseCheckpoint = {
    router: TESTNET.router,
    account: validAccount,
    recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    destination: "sepolia",
    route: 1,
    bridgeAmount: "10000000",
    stage: "bridge" as const,
    txHash: realHash,
  };

  it("preserves the real signed hash exactly in a saved checkpoint", () => {
    const parsed = parseCheckpoint(JSON.stringify(baseCheckpoint));
    expect(parsed).not.toBeNull();
    if (!parsed) throw new Error("Expected a valid checkpoint.");
    expect(parsed.txHash).toBe(realHash);
    expect(parsed.txHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses the configured testnet network for explorer access", () => {
    expect(TESTNET.networkPassphrase).toContain("Test SDF Network");
    expect(TESTNET.horizonUrl).toContain("horizon-testnet");
  });

  it("rejects a fabricated or truncated hash so no false identity is displayed", () => {
    expect(
      parseCheckpoint(JSON.stringify({ ...baseCheckpoint, txHash: "a".repeat(16) })),
    ).toBeNull();
    expect(parseCheckpoint(JSON.stringify({ ...baseCheckpoint, txHash: "not-a-hash" }))).toBeNull();
    expect(
      parseCheckpoint(JSON.stringify({ ...baseCheckpoint, txHash: "G".repeat(64) })),
    ).toBeNull();
  });

  it("treats an unknown outcome as pending rather than fabricating confirmation", () => {
    // A checkpoint with a valid hash but no on-chain confirmation is honest: status stays pending.
    const parsed = parseCheckpoint(JSON.stringify(baseCheckpoint));
    expect(parsed).not.toBeNull();
    if (!parsed) throw new Error("Expected a valid checkpoint.");
    expect(parsed.txHash).toBe(realHash);
    // The checkpoint itself carries no status; confirmation comes only from readTransaction.
    expect(parsed.stage).toBe("bridge");
  });
});

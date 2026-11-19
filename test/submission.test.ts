import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Address,
  Contract,
  Keypair,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  type xdr,
} from "@stellar/stellar-sdk";
import { toHex } from "@hyperion/protocol";
import {
  classifySubmissionFailure,
  SubmissionFailure,
  quoteFreshness,
  quoteBreakdown,
  type LiveQuote,
  submitSettleClaim,
  submitOperation,
  simulateOperation,
} from "../src/contracts/stellar";
import { parseBridgeFormParams } from "../src/components/bridge/Bridge";
import { USDC, XLM } from "../src/contracts/assets";
import { checkpointMatches, parseCheckpoint } from "../src/contracts/checkpoint";
import { createSubmissionMachine, transitionSubmission } from "../src/contracts/submission-machine";

import { STELLAR_DEPLOYMENT, TESTNET } from "../src/config/testnet";
import { inspectCheckpointStorage } from "../src/contracts/checkpoint";
import {
  planMaxUsdcAmount,
  planMaxSourceAmount,
  XLM_MINIMUM_RESERVE,
} from "../src/lib/max-planner";

// Deterministic test-only signer; this test never connects to a network.
const key = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(7));
const success = (retval: xdr.ScVal): rpc.Api.SimulateTransactionSuccessResponse => ({
  id: "test",
  latestLedger: 1,
  events: [],
  _parsed: true,
  transactionData: new SorobanDataBuilder().setResourceFee(100),
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
  it("rejects invalid transitions so duplicate send controls cannot be enabled", () => {
    const machine = createSubmissionMachine();
    expect(() => transitionSubmission(machine, "broadcast")).toThrow(/invalid transition/);
    const signed = transitionSubmission(
      transitionSubmission(transitionSubmission(machine, "prepare"), "review"),
      "sign",
    );
    expect(signed.canSend).toBe(false);
  });
  it("retains account and hash bound pending state for unknown outcomes", () => {
    const hash = "a".repeat(64);
    const state = transitionSubmission(
      transitionSubmission(
        transitionSubmission(
          transitionSubmission(transitionSubmission(createSubmissionMachine(), "prepare"), "review"),
          "sign",
        ),
        "checkpoint",
        { account: key.publicKey(), txHash: hash },
      ),
      "broadcast",
    );
    expect(state.phase).toBe("broadcast");
    expect(state.pending).toEqual({ account: key.publicKey(), txHash: hash });
  });
  it("handles cancellation and delayed async results without resubmitting", () => {
    const machine = transitionSubmission(createSubmissionMachine(), "prepare");
    const cancelled = transitionSubmission(machine, "cancel");
    expect(cancelled.phase).toBe("cancelled");
    expect(() => transitionSubmission(cancelled, "confirm")).toThrow(/invalid transition/);
  });
  it("distinguishes writable recovery storage from a blocked store without claiming guaranteed persistence", () => {
    const checkpointKey = "hyperion.testnet.pending-transfer";
    const values = new Map<string, string>([[checkpointKey, "existing signed hash"]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
    expect(inspectCheckpointStorage(storage)).toMatchObject({
      available: true,
      persistent: null,
      kind: "transaction-recovery",
      reason: null,
    });
    expect([...values]).toEqual([[checkpointKey, "existing signed hash"]]);
    const blocked = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    };
    expect(inspectCheckpointStorage(blocked)).toMatchObject({
      available: false,
      persistent: false,
      kind: "transaction-recovery",
    });
  });
  it("rejects a store that silently drops writes before an approval can rely on it", () => {
    expect(
      inspectCheckpointStorage({
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      }),
    ).toMatchObject({
      available: false,
      persistent: false,
      reason: "The browser did not retain the recovery probe.",
    });
  });
  it("classifies bounded pre-broadcast failures without attaching a fake hash", () => {
    const failure = classifySubmissionFailure("approval", new Error("declined\nsecret details"));
    expect(failure).toBeInstanceOf(SubmissionFailure);
    expect(failure.stage).toBe("approval");
    expect(failure.message).toBe("declined");
    expect(failure.txHash).toBeUndefined();
  });
  it("labels provider observations by freshness without implying delivery", () => {
    const observedAt = "2026-11-18T20:00:00.000Z";
    expect(quoteFreshness({ observedAt }, Date.parse("2026-11-18T20:00:29.000Z"))).toBe("current");
    expect(quoteFreshness({ observedAt }, Date.parse("2026-11-18T20:00:31.000Z"))).toBe("stale");
    expect(quoteFreshness({ observedAt: "not-a-date" })).toBe("unknown");
    expect(quoteFreshness({ observedAt }, Date.parse("2026-11-18T19:59:59.000Z"))).toBe("unknown");
  });
  it("recovers the exact precision dust a CCTP route's six-decimal destination truncates", () => {
    // 7-decimal Stellar USDC minus the fee leaves 9,969,995 base units -- not a multiple of
    // the 10-unit quantum that six-decimal Circle USDC can represent, so the trailing 5 base
    // units (0.0000005 USDC) stay in the source account and are never debited or bridged.
    const value: LiveQuote = {
      route: 0,
      adapter: TESTNET.router,
      destination: "sepolia",
      requestedAmount: 10000000n,
      grossAmount: 9999995n,
      fee: 30005n,
      netAmount: 9969990n,
      representableAmount: 996999n,
      destinationAmount: 946999n,
      flowAvailable: 10000000000n,
      ledger: 1,
      relayGas: 500000n,
    };
    expect(quoteBreakdown(value)).toEqual({
      requestedSourceAmount: 10000000n,
      actualSourceDebit: 9999995n,
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
      actualSourceDebit: 10000009n,
      protocolFee: 30000n,
      representableBridgeAmount: 9970009n,
      retainedDust: 0n,
    });
  });

  it("never broadcasts a valid signature returned after its envelope deadline", async () => {
    const { send } = setup();
    const approval = vi.fn(async (envelope: string) => {
      const signed = await sign(envelope);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 181000);
      return signed;
    });
    const progress = vi.fn();
    await expect(
      submitOperation(
        TESTNET.reader,
        new Contract(TESTNET.router).call("noop"),
        approval,
        progress,
      ),
    ).rejects.toThrow(/expired before broadcast/);
    expect(approval).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(progress.mock.calls.some((call) => call[0] === "submitting")).toBe(false);
  });
  it("rejects a quote whose gross debit includes retained dust or whose payout floors to zero", () => {
    const value: LiveQuote = {
      route: 0,
      adapter: TESTNET.router,
      destination: "sepolia",
      requestedAmount: 10000000n,
      grossAmount: 9999995n,
      fee: 30005n,
      netAmount: 9969990n,
      representableAmount: 996999n,
      destinationAmount: 946999n,
      flowAvailable: 10000000000n,
      ledger: 1,
      relayGas: 500000n,
    };
    expect(() => quoteBreakdown({ ...value, grossAmount: value.requestedAmount })).toThrow(
      /conserve/,
    );
    expect(() => quoteBreakdown({ ...value, destinationAmount: 0n })).toThrow(/conserve/);
    expect(() => quoteBreakdown({ ...value, netAmount: 0n, representableAmount: 0n })).toThrow(
      /conserve/,
    );
  });

  it("classifies simulation transport failure without wallet approval or broadcast", async () => {
    const { simulation, send } = setup();
    simulation.mockReset().mockRejectedValue(new Error("Provider unavailable"));
    const approve = vi.fn();
    await expect(
      submitOperation(TESTNET.reader, new Contract(TESTNET.router).call("noop"), approve),
    ).rejects.toMatchObject({ stage: "simulation", txHash: undefined });
    expect(approve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it("blocks broadcast when required checkpoint persistence fails", async () => {
    const { send } = setup();
    const progress = (phase: string) => {
      if (phase === "submitting") throw new Error("Recovery storage is unavailable");
    };
    await expect(
      submitOperation(TESTNET.reader, new Contract(TESTNET.router).call("noop"), sign, progress),
    ).rejects.toMatchObject({ stage: "checkpoint", txHash: undefined });
    expect(send).not.toHaveBeenCalled();
  });
  it("retains the actual signed hash and broadcast stage for an uncertain network send", async () => {
    const { send } = setup();
    send.mockRejectedValueOnce(new Error("Provider timed out"));
    const result = await submitOperation(
      TESTNET.reader,
      new Contract(TESTNET.router).call("noop"),
      sign,
    );
    expect(result.status).toBe("pending");
    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.failure).toMatchObject({ stage: "broadcast", txHash: result.txHash });
  });
  it("keeps classification bounded and strips hashes from pre-broadcast stages", () => {
    expect(
      classifySubmissionFailure("build", new Error("x".repeat(1000)), "a".repeat(64)),
    ).toMatchObject({ stage: "build", message: "x".repeat(400), txHash: undefined });
    expect(classifySubmissionFailure("broadcast", "timeout", "fake").txHash).toBeUndefined();
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
    expect(result).toMatchObject({
      status: "pending",
      txHash: hash,
      failure: { stage: "broadcast", txHash: hash },
    });
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
  it("blocks approval and rejects submission when simulation fails", async () => {
    const { simulation, send } = setup();
    simulation.mockReset();
    simulation.mockResolvedValue({
      id: "test",
      latestLedger: 1,
      _parsed: true,
      events: [],
      error: "unsupported route on router",
    });
    const wallet = vi.fn(sign);
    const op = new Contract(TESTNET.router).call(
      "settle_claim",
      new Address(key.publicKey()).toScVal(),
      nativeToScVal(1n, { type: "u64" }),
    );
    await expect(submitOperation(key.publicKey(), op, wallet)).rejects.toThrow(
      "unsupported route on router",
    );
    expect(wallet).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it("submits the exact assembled envelope matching the displayed operation", async () => {
    const { simulation, send } = setup();
    simulation.mockReset();
    simulation.mockResolvedValue(success(nativeToScVal(1n)));
    let hash: string | undefined;
    send.mockImplementation((tx) => {
      hash = toHex(tx.hash()).slice(2);
      return Promise.reject(new Error("timeout"));
    });
    const op = new Contract(TESTNET.router).call(
      "settle_claim",
      new Address(key.publicKey()).toScVal(),
      nativeToScVal(1n, { type: "u64" }),
    );
    const sim = await simulateOperation(key.publicKey(), op);
    expect(sim.resourceFee).toBe(100n);
    expect(sim.networkFee).toBe(100n);
    expect(sim.totalFee).toBe(200n);

    let submittedXdr: string | undefined;
    const wallet = vi.fn((xdrVal: string) => {
      submittedXdr = xdrVal;
      return sign(xdrVal);
    });

    const result = await submitOperation(
      key.publicKey(),
      op,
      wallet,
      undefined,
      undefined,
      undefined,
      sim,
    );
    expect(result).toMatchObject({
      status: "pending",
      txHash: hash,
      failure: { stage: "broadcast", txHash: hash },
    });
    expect(wallet).toHaveBeenCalledTimes(1);
    expect(submittedXdr).toBe(sim.envelopeXdr);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("rejects submission when displayed operation does not correspond to the simulated envelope", async () => {
    const { simulation, send } = setup();
    simulation.mockReset();
    simulation.mockResolvedValue(success(nativeToScVal(1n)));
    const op1 = new Contract(TESTNET.router).call(
      "settle_claim",
      new Address(key.publicKey()).toScVal(),
      nativeToScVal(1n, { type: "u64" }),
    );
    const op2 = new Contract(TESTNET.router).call(
      "settle_claim",
      new Address(key.publicKey()).toScVal(),
      nativeToScVal(2n, { type: "u64" }),
    );
    const sim = await simulateOperation(key.publicKey(), op2);
    const wallet = vi.fn(sign);
    await expect(
      submitOperation(key.publicKey(), op1, wallet, undefined, undefined, undefined, sim),
    ).rejects.toThrow(
      "Displayed operation does not correspond to the envelope sent to the wallet.",
    );
    expect(wallet).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it("exposes actual assembled resource fee and network fee distinctly", async () => {
    const { simulation } = setup();
    simulation.mockReset();
    const simSuccess: rpc.Api.SimulateTransactionSuccessResponse = {
      id: "test",
      latestLedger: 1,
      events: [],
      _parsed: true,
      transactionData: new SorobanDataBuilder().setResourceFee(45000),
      minResourceFee: "45000",
      result: { auth: [], retval: nativeToScVal(1n) },
    };
    simulation.mockResolvedValue(simSuccess);
    const op = new Contract(TESTNET.router).call(
      "settle_claim",
      new Address(key.publicKey()).toScVal(),
      nativeToScVal(1n, { type: "u64" }),
    );
    const sim = await simulateOperation(key.publicKey(), op);
    expect(sim.resourceFee).toBe(45000n);
    expect(sim.totalFee).toBe(45100n);
    expect(sim.networkFee).toBe(100n);
    expect(sim.preparedTransaction.fee).toBe("45100");
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
  it("stops polling on abort without resubmitting or clearing the signed hash", async () => {
    const { send } = setup();
    send.mockResolvedValue({
      status: "SUCCESS" as rpc.Api.SendTransactionStatus,
      hash: "0x" + "0".repeat(64),
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    });
    const controller = new AbortController();
    const promise = submitSettleClaim(
      key.publicKey(),
      1n,
      sign,
      undefined,
      undefined,
      controller.signal,
    );
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

describe("Spendable-balance maximum amount planner", () => {
  // Shared fixture values in 7-decimal (stroop-equivalent) units.
  // 100 USDC = 1_000_000_000n, 10 XLM = 100_000_000n, 50 USDC flow cap = 500_000_000n.
  const usdc100 = 1_000_000_000n;
  const xlm10 = 100_000_000n;
  const flow50 = 500_000_000n;
  const gas1xlm = 10_000_000n; // 1 XLM estimated relay gas (ITS route)
  const gas1usdc = 10_000_000n; // 1 USDC estimated relay gas (CCTP route)

  describe("planMaxUsdcAmount - ITS route (route 1)", () => {
    it("returns min(usdcSpendable, flowAvailable) when XLM covers gas and reserve", () => {
      const result = planMaxUsdcAmount({
        route: 1,
        usdcSpendable: usdc100,
        xlmSpendable: xlm10,
        flowAvailable: flow50,
        estimatedRelayGas: gas1xlm,
      });
      // xlm10 (100_000_000) - relayBudget(gas1xlm) - XLM_MINIMUM_RESERVE
      // relayBudget(10_000_000) = ceil(10_000_000 * 110 / 100) = 11_000_000
      // 100_000_000 - 11_000_000 - 20_000_000 = 69_000_000 >= 0 -> ok
      // cap = min(usdc100, flow50) = flow50
      expect(result).toBe(flow50);
    });

    it("caps at usdcSpendable when it is below flowAvailable", () => {
      const result = planMaxUsdcAmount({
        route: 1,
        usdcSpendable: 300_000_000n, // 30 USDC
        xlmSpendable: xlm10,
        flowAvailable: flow50,
        estimatedRelayGas: gas1xlm,
      });
      expect(result).toBe(300_000_000n);
    });

    it("returns null when XLM cannot cover relay gas and minimum reserve", () => {
      // xlmSpendable just below threshold: relayBudget(gas1xlm) + XLM_MINIMUM_RESERVE
      // = 11_000_000 + 20_000_000 = 31_000_000; give 30_000_000 -> insufficient
      const result = planMaxUsdcAmount({
        route: 1,
        usdcSpendable: usdc100,
        xlmSpendable: 30_000_000n,
        flowAvailable: flow50,
        estimatedRelayGas: gas1xlm,
      });
      expect(result).toBeNull();
    });

    it("returns null when estimatedRelayGas is zero (missing pricing)", () => {
      const result = planMaxUsdcAmount({
        route: 1,
        usdcSpendable: usdc100,
        xlmSpendable: xlm10,
        flowAvailable: flow50,
        estimatedRelayGas: 0n,
      });
      expect(result).toBeNull();
    });

    it("returns null when flowAvailable is zero", () => {
      const result = planMaxUsdcAmount({
        route: 1,
        usdcSpendable: usdc100,
        xlmSpendable: xlm10,
        flowAvailable: 0n,
        estimatedRelayGas: gas1xlm,
      });
      expect(result).toBeNull();
    });
  });

  describe("planMaxUsdcAmount - CCTP route (route 0)", () => {
    it("subtracts relay budget from USDC balance and caps at flowAvailable", () => {
      // relayBudget(gas1usdc) = 11_000_000
      // usdcAfterRelay = usdc100 - 11_000_000 = 989_000_000
      // cap = min(989_000_000, flow50) = flow50
      const result = planMaxUsdcAmount({
        route: 0,
        usdcSpendable: usdc100,
        xlmSpendable: xlm10,
        flowAvailable: flow50,
        estimatedRelayGas: gas1usdc,
      });
      expect(result).toBe(flow50);
    });

    it("caps at usdcAfterRelay when it is below flowAvailable", () => {
      const tinyUsdc = 15_000_000n; // 1.5 USDC
      // relayBudget(gas1usdc) = 11_000_000
      // usdcAfterRelay = 15_000_000 - 11_000_000 = 4_000_000
      // cap = min(4_000_000, flow50) = 4_000_000
      const result = planMaxUsdcAmount({
        route: 0,
        usdcSpendable: tinyUsdc,
        xlmSpendable: xlm10,
        flowAvailable: flow50,
        estimatedRelayGas: gas1usdc,
      });
      expect(result).toBe(4_000_000n);
    });

    it("returns null when relay budget exceeds usdcSpendable", () => {
      // usdcSpendable = 5_000_000 (0.5 USDC); relayBudget = 11_000_000 -> negative
      const result = planMaxUsdcAmount({
        route: 0,
        usdcSpendable: 5_000_000n,
        xlmSpendable: xlm10,
        flowAvailable: flow50,
        estimatedRelayGas: gas1usdc,
      });
      expect(result).toBeNull();
    });

    it("returns null when estimatedRelayGas is zero (missing pricing)", () => {
      const result = planMaxUsdcAmount({
        route: 0,
        usdcSpendable: usdc100,
        xlmSpendable: xlm10,
        flowAvailable: flow50,
        estimatedRelayGas: 0n,
      });
      expect(result).toBeNull();
    });

    it("requires native transaction fee funds on the CCTP route", () => {
      // CCTP forwarding uses USDC, but its transaction still needs native fee funds.
      const result = planMaxUsdcAmount({
        route: 0,
        usdcSpendable: usdc100,
        xlmSpendable: 0n,
        flowAvailable: flow50,
        estimatedRelayGas: gas1usdc,
      });
      expect(result).toBeNull();
    });
  });

  describe("planMaxUsdcAmount - flowAvailable cap", () => {
    it("never exceeds flowAvailable regardless of balance on ITS route", () => {
      const result = planMaxUsdcAmount({
        route: 1,
        usdcSpendable: 10_000_000_000n, // 1000 USDC
        xlmSpendable: 1_000_000_000n, // 100 XLM
        flowAvailable: flow50,
        estimatedRelayGas: gas1xlm,
      });
      expect(result).toBe(flow50);
    });

    it("never exceeds flowAvailable regardless of balance on CCTP route", () => {
      const result = planMaxUsdcAmount({
        route: 0,
        usdcSpendable: 10_000_000_000n,
        xlmSpendable: xlm10,
        flowAvailable: flow50,
        estimatedRelayGas: gas1usdc,
      });
      expect(result).toBe(flow50);
    });
  });

  describe("planMaxSourceAmount - non-USDC source", () => {
    it("returns spendableSourceUnits when trustline is present", () => {
      const result = planMaxSourceAmount({
        spendableSourceUnits: 500_000_000n,
        trustlineOk: true,
      });
      expect(result).toBe(500_000_000n);
    });

    it("returns spendableSourceUnits when trustline is native (XLM)", () => {
      const result = planMaxSourceAmount({
        spendableSourceUnits: 200_000_000n,
        trustlineOk: true,
      });
      expect(result).toBe(200_000_000n);
    });

    it("returns null when trustline is frozen", () => {
      const result = planMaxSourceAmount({
        spendableSourceUnits: 500_000_000n,
        trustlineOk: false,
      });
      expect(result).toBeNull();
    });

    it("returns null when spendable balance is zero", () => {
      const result = planMaxSourceAmount({
        spendableSourceUnits: 0n,
        trustlineOk: true,
      });
      expect(result).toBeNull();
    });
  });

  describe("Exact integer preservation", () => {
    it("XLM_MINIMUM_RESERVE is a positive bigint with 7-decimal stroop precision", () => {
      expect(typeof XLM_MINIMUM_RESERVE).toBe("bigint");
      expect(XLM_MINIMUM_RESERVE).toBe(20_000_000n);
    });

    it("planMaxUsdcAmount preserves exact bigint arithmetic without float rounding", () => {
      // Use an amount that would lose precision under float arithmetic.
      const oddBalance = 999_999_999n;
      const oddFlow = 999_999_997n;
      const result = planMaxUsdcAmount({
        route: 0,
        usdcSpendable: oddBalance,
        xlmSpendable: xlm10,
        flowAvailable: oddFlow,
        estimatedRelayGas: gas1usdc,
      });
      // relayBudget(10_000_000) = 11_000_000
      // usdcAfterRelay = 999_999_999 - 11_000_000 = 988_999_999
      // cap = min(988_999_999, 999_999_997) = 988_999_999
      expect(result).toBe(988_999_999n);
    });
  });
});

describe("Bridge form URL state", () => {
  const recipient = "0x" + "1".repeat(40);

  it.each(["0", "-1", "1e3", "1.00000001", "922337203686"])(
    "rejects invalid shared spending amount %s",
    (amount) => {
      expect(
        parseBridgeFormParams(`?a=${amount}&r=${recipient}&d=sepolia&t=1&s=native`),
      ).toBeNull();
    },
  );
  it("rejects unsupported lanes, duplicate form keys and overlong public inputs", () => {
    expect(parseBridgeFormParams(`?a=1&r=${recipient}&d=base-sepolia&t=1&s=native`)).toBeNull();
    expect(parseBridgeFormParams(`?a=1&a=2&r=${recipient}&d=sepolia&t=1&s=native`)).toBeNull();
    expect(parseBridgeFormParams("?a=" + "1".repeat(2100))).toBeNull();
    expect(parseBridgeFormParams(`?s=FOO:${USDC.issuer}:extra`)).toBeNull();
  });
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
      `?a=1&r=${recipient}&d=sepolia&t=1&s=native&utm_source=email&checkpoint=abc&signature=x`,
    );
    expect(state).toEqual({
      amount: "1",
      recipient,
      destination: "sepolia",
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

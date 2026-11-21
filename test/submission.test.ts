import { cctpPayoutBreakdown } from "../src/lib/relay-budget";
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
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { formatUnits, sorobanErrorCode, toHex } from "@hyperion/protocol";
import {
  QuoteChangedError,
  readCheckpointTransaction,
  readTransaction,
  createReviewedIntentSnapshot,
  reviewedBridgeMatches,
  reviewedIntentMatches,
  assertReviewedFeeCurrent,
  bridgeOperation,
  classifySubmissionFailure,
  describeBindingLimit,
  SubmissionFailure,
  quoteFreshness,
  quoteBreakdown,
  parseSendAmount,
  type LiveQuote,
  submitBridgeOut,
  submitSettleClaim,
  submitOperation,
  simulateOperation,
  TransferLimitError,
} from "../src/contracts/stellar";
import { compareQuotes } from "../src/lib/quote-diff";
import { parseBridgeFormParams } from "../src/components/bridge/Bridge";
import { USDC, XLM } from "../src/contracts/assets";
import { checkpointMatches, parseCheckpoint, saveCheckpoint } from "../src/contracts/checkpoint";
import { createSubmissionMachine, transitionSubmission } from "../src/contracts/submission-machine";

import { archivedRouterFor, DESTINATIONS, STELLAR_DEPLOYMENT, TESTNET, supportedLanes } from "../src/config/testnet";
import { inspectCheckpointStorage } from "../src/contracts/checkpoint";
import {
  planMaxUsdcAmount,
  planMaxSourceAmount,
  XLM_MINIMUM_RESERVE,
} from "../src/lib/max-planner";

// Deterministic test-only signer; this test never connects to a network.
const key = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(7));
const otherKey = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(8));
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
// Unlike setup(), the claim read is answered the same way on every call. Each independent
// submitSettleClaim call reads the claim before submitting its own operation, so a test that
// drives the function more than once (a retry, or two overlapping calls) needs that read to stay
// valid every time rather than only for the very first simulateTransaction call in the test.
function repeatableSetup() {
  vi.spyOn(rpc.Server.prototype, "getNetwork").mockResolvedValue({
    passphrase: TESTNET.networkPassphrase,
    protocolVersion: "27",
  });
  // Each call must see a fresh, unmutated Account: the SDK's TransactionBuilder increments the
  // sequence number on the very instance it is given, so reusing one Account across getAccount
  // calls would make the post-construction sequence check see its own earlier mutation as a
  // real on-chain sequence change. A retry or a second overlapping call must start from "0" too.
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
  vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue(
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
  const send = vi.spyOn(rpc.Server.prototype, "sendTransaction");
  return { send };
}
const sign = (value: string) => {
  const tx = TransactionBuilder.fromXdr(value, TESTNET.networkPassphrase);
  tx.sign(key);
  return Promise.resolve({ signedTxXdr: tx.toXdr() });
};
afterEach(() => vi.restoreAllMocks());

describe("Immutable reviewed transfer intent", () => {
  const intent = createReviewedIntentSnapshot({
    account: key.publicKey(),
    asset: {
      id: USDC.id,
      code: USDC.code,
      issuer: USDC.issuer,
    },
    destination: "sepolia",
    route: 0,
    recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    amount: 9007199254740993n,
    sourceDebit: 9007199254740993n,
    protocolFee: 30000n,
    netAmount: 9007199254710993n,
    representableAmount: 9007199254710993n,
    adapter: TESTNET.router,
    minimum: 9007199254740001n,
    providerBudget: 123450n,
    estimatedProviderBudget: 112230n,
    sourceAmount: 9007199254740993n,
    sourceMaximum: null,
    stage: "bridge",
  });

  it("freezes the public intent snapshot and its issuer-specific asset identity", () => {
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.asset)).toBe(true);
    expect(reviewedIntentMatches(intent, { ...intent, asset: { ...intent.asset } })).toBe(true);
  });

  it("rejects changes to any payout-affecting field or exact integer amount", () => {
    const changed = [
      { ...intent, account: otherKey.publicKey() },
      { ...intent, asset: { ...intent.asset, issuer: otherKey.publicKey() } },
      { ...intent, destination: "base-sepolia" as const },
      { ...intent, route: 1 as const },
      { ...intent, recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c9" },
      { ...intent, amount: 9007199254740992n },
      { ...intent, minimum: 9007199254740000n },
      { ...intent, providerBudget: 123451n },
      { ...intent, estimatedProviderBudget: 112231n },
      { ...intent, sourceAmount: 9007199254740992n },
      { ...intent, stage: "conversion" as const },
    ];
    for (const candidate of changed) expect(reviewedIntentMatches(intent, candidate)).toBe(false);
  });

  it("blocks bridge signing when the submitted quote differs from the reviewed payout", () => {
    const bridge = {
      account: intent.account,
      recipient: intent.recipient,
      destination: intent.destination,
      route: intent.route,
      amount: intent.amount,
      sourceDebit: intent.sourceDebit,
      protocolFee: intent.protocolFee,
      netAmount: intent.netAmount,
      representableAmount: intent.representableAmount,
      adapter: intent.adapter,
      minimum: intent.minimum,
      providerBudget: intent.providerBudget,
      estimatedProviderBudget: intent.estimatedProviderBudget,
    };
    expect(reviewedBridgeMatches(intent, bridge)).toBe(true);
    expect(reviewedBridgeMatches(intent, { ...bridge, minimum: bridge.minimum + 1n })).toBe(false);
    expect(
      reviewedBridgeMatches(intent, { ...bridge, providerBudget: bridge.providerBudget + 1n }),
    ).toBe(false);
  });

  it("copies only public reviewed fields and detects deployment changes", () => {
    const input = {
      ...intent,
      signedTxXdr: "fixture-envelope",
      walletSecret: "fixture-extra",
      asset: { ...intent.asset, signingMetadata: "fixture-extra" },
    };
    const snapshot = createReviewedIntentSnapshot(input);
    expect(snapshot).not.toHaveProperty("signedTxXdr");
    expect(snapshot).not.toHaveProperty("walletSecret");
    expect(snapshot.asset).not.toHaveProperty("signingMetadata");
    for (const change of [
      { network: "other-network" },
      { router: TESTNET.token },
      { token: TESTNET.router },
    ])
      expect(reviewedIntentMatches(snapshot, { ...snapshot, ...change })).toBe(false);
  });

  it("refuses mismatched payout fields in actual bridge submission before any wallet or RPC call", async () => {
    const wallet = vi.fn(sign);
    const rpcRead = vi.spyOn(rpc.Server.prototype, "getNetwork");
    const quote: LiveQuote = {
      route: 0,
      adapter: intent.adapter,
      destination: intent.destination,
      requestedAmount: intent.amount,
      grossAmount: intent.sourceDebit,
      fee: intent.protocolFee,
      netAmount: intent.netAmount,
      representableAmount: intent.representableAmount,
      destinationAmount: intent.minimum,
      relayGas: intent.providerBudget,
      estimatedRelayGas: intent.estimatedProviderBudget,
      flowAvailable: intent.amount * 2n,
      ledger: 1,
    };
    for (const change of [
      { fee: quote.fee + 1n },
      { grossAmount: quote.grossAmount - 1n },
      { destinationAmount: quote.destinationAmount - 1n },
      { relayGas: quote.relayGas + 1n },
      { adapter: TESTNET.token },
      { requestedAmount: quote.requestedAmount + 1n },
    ]) {
      await expect(
        submitBridgeOut(
          intent.account,
          { ...quote, ...change },
          intent.recipient,
          wallet,
          undefined,
          undefined,
          { expectedAccount: intent.account, reviewedIntent: intent },
        ),
      ).rejects.toThrow("reviewed transfer intent changed");
    }
    for (const change of [
      { asset: XLM },
      { sourceAmount: intent.sourceAmount - 1n },
      { sourceMaximum: intent.sourceAmount },
      { network: "other-network" },
    ]) {
      await expect(
        submitBridgeOut(intent.account, quote, intent.recipient, wallet, undefined, undefined, {
          expectedAccount: intent.account,
          reviewedIntent: { ...intent, ...change },
        }),
      ).rejects.toThrow("reviewed transfer intent changed");
    }
    expect(wallet).not.toHaveBeenCalled();
    expect(rpcRead).not.toHaveBeenCalled();
  });

  it("only exposes testnet lanes with destination-specific delivered evidence", () => {
    expect(DESTINATIONS.map(({ key: destination, routes }) => [destination, routes])).toEqual([
      ["sepolia", [0, 1]],
      ["base-sepolia", [0]],
      ["arc-testnet", [0]],
    ]);
  });
});

describe("Refreshed quote field-level diff", () => {
  const reviewedQuote = {
    route: 1 as 0 | 1,
    destination: "sepolia",
    adapter: "axelar-its",
    requestedAmount: 9007199254740993n,
    grossAmount: 9007199254740993n,
    fee: 1_000_000n,
    destinationAmount: 9007199254740001n,
    relayGas: 123_450n,
    estimatedRelayGas: 112_230n,
    ledger: 100,
  };
  const refreshedQuote = (overrides: Partial<typeof reviewedQuote> = {}) => ({
    ...reviewedQuote,
    ledger: 101,
    ...overrides,
  });

  it("drives materiality from exact base units even when display rounding hides the change", () => {
    const diff = compareQuotes(
      { ...reviewedQuote, fee: 1_000_000n },
      refreshedQuote({ fee: 1_000_001n }),
      { displayDecimals: 2 },
    );
    const fee = diff.fields.find((field) => field.key === "fee");
    expect(fee?.reviewedDisplay).toBe("0.1 USDC");
    expect(fee?.refreshedDisplay).toBe("0.1 USDC");
    expect(fee?.delta).toBe(1n);
    expect(fee?.direction).toBe("worse");
    expect(diff.materialWorsening).toBe(true);
  });

  it("reports a single-unit minimum worsening and provider budget increase exactly", () => {
    const diff = compareQuotes(
      reviewedQuote,
      refreshedQuote({
        destinationAmount: reviewedQuote.destinationAmount - 1n,
        relayGas: reviewedQuote.relayGas + 1n,
      }),
    );
    const minimum = diff.fields.find((field) => field.key === "minimum");
    const budget = diff.fields.find((field) => field.key === "providerBudget");
    expect(minimum?.delta).toBe(-1n);
    expect(minimum?.direction).toBe("worse");
    expect(budget?.delta).toBe(1n);
    expect(budget?.direction).toBe("worse");
    expect(minimum?.unit).toBe("USDC (ITS)");
    expect(budget?.unit).toBe("XLM");
    expect(diff.materialWorsening).toBe(true);
  });

  it("shows improvements without changing any reviewed intent value", () => {
    const diff = compareQuotes(
      reviewedQuote,
      refreshedQuote({
        fee: reviewedQuote.fee - 1n,
        destinationAmount: reviewedQuote.destinationAmount + 1n,
        relayGas: reviewedQuote.relayGas - 1n,
        estimatedRelayGas: reviewedQuote.estimatedRelayGas - 1n,
      }),
    );
    expect(diff.improved).toBe(true);
    expect(diff.materialWorsening).toBe(false);
    for (const field of diff.fields.filter((entry) => entry.delta !== null)) {
      expect(field.direction).toBe("better");
    }
    const fee = diff.fields.find((field) => field.key === "fee");
    expect(fee?.reviewed).toBe(reviewedQuote.fee);
    expect(fee?.refreshed).toBe(reviewedQuote.fee - 1n);
  });

  it("treats route configuration changes as a material review trigger", () => {
    const diff = compareQuotes(reviewedQuote, refreshedQuote({ route: 0, adapter: "circle-cctp" }));
    const route = diff.fields.find((field) => field.key === "route");
    expect(route?.direction).toBe("changed");
    expect(route?.material).toBe(true);
    expect(diff.fields.some((field) => field.key === "adapter" && field.material)).toBe(true);
    expect(diff.materialWorsening).toBe(true);
  });

  it("keeps a new ledger informational and reports an unchanged quote as no diff", () => {
    expect(compareQuotes(reviewedQuote, { ...reviewedQuote }).changed).toBe(false);
    const diff = compareQuotes(reviewedQuote, refreshedQuote());
    expect(diff.changed).toBe(true);
    expect(diff.materialWorsening).toBe(false);
    expect(diff.fields).toHaveLength(1);
    expect(diff.fields[0]?.key).toBe("ledger");
    expect(diff.fields[0]?.material).toBe(false);
  });

  it("carries the field diff on the pre-signing review error", () => {
    const diff = compareQuotes(
      reviewedQuote,
      refreshedQuote({ destinationAmount: reviewedQuote.destinationAmount - 1n }),
    );
    const error = new QuoteChangedError(diff);
    expect(error.diff).toBe(diff);
    expect(error.message).toMatch(/reviewed quote/);
  });
});

describe("Signed Stellar submission failure boundaries", () => {
  it("refuses fresh claim data that differs from the reviewed amount before wallet approval", async () => {
    const { send } = setup();
    const wallet = vi.fn(sign);
    await expect(
      submitSettleClaim(key.publicKey(), 1n, wallet, undefined, undefined, undefined, {
        id: 1n,
        recipient: key.publicKey(),
        token: TESTNET.token,
        amount: 20n,
        settled: false,
        eligibility: {
          status: "eligible",
          reason: "Generated fixture",
          previewMethod: "preview_settle_claim",
          trustline: "not-required",
        },
        deployment: {
          ...STELLAR_DEPLOYMENT,
          chain: "stellar-testnet",
          router: TESTNET.router,
          networkPassphrase: TESTNET.networkPassphrase,
          commit: "fixture",
          deployedLedger: 1,
        },
      }),
    ).rejects.toThrow(/claim changed/);
    expect(wallet).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
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
  it("deducts the complete approved Circle forwarding budget in destination units", () => {
    expect(cctpPayoutBreakdown(996999n, 500000n)).toEqual({
      destinationBudget: 50000n,
      minimumReceived: 946999n,
    });
    expect(cctpPayoutBreakdown(2n, 10n)).toEqual({ destinationBudget: 1n, minimumReceived: 1n });
    for (const [amount, budget] of [
      [1n, 10n],
      [0n, 10n],
      [2n, 11n],
      [2n, -10n],
      [2n, 30n],
    ] as const)
      expect(() => cctpPayoutBreakdown(amount, budget)).toThrow();
  });
  it("encodes the exact displayed CCTP minimum and approved forwarding budget in the router request", () => {
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
    const operation = bridgeOperation(key.publicKey(), value, "0x" + "1".repeat(40));
    const transaction = new TransactionBuilder(new Account(key.publicKey(), "0"), {
      fee: "100",
      networkPassphrase: TESTNET.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(180)
      .build();
    const envelope = xdr.TransactionEnvelope.fromXdr(transaction.toXdr(), "base64");
    if (envelope.type !== "envelopeTypeTx") throw new Error("Expected a v1 transaction");
    const operationBody = envelope.v1.tx.operations[0];
    if (!operationBody) throw new Error("Expected a router operation");
    const body = operationBody.body;
    if (body.type !== "invokeHostFunction") throw new Error("Expected a contract operation");
    const hostFunction = body.invokeHostFunctionOp.hostFunction;
    if (hostFunction.type !== "hostFunctionTypeInvokeContract")
      throw new Error("Expected a contract invocation");
    const args = hostFunction.invokeContract.args;
    const request = args[1];
    const budget = args[2];
    if (!request || !budget) throw new Error("Expected router request and relay budget");
    expect(scValToNative(request)).toMatchObject({
      amount: 10000000n,
      destination_decimals: 6,
      min_destination_amount: 946999n,
    });
    expect(scValToNative(budget)).toBe(500000n);
    expect(cctpPayoutBreakdown(value.representableAmount, value.relayGas).minimumReceived).toBe(
      946999n,
    );
  });
  it("holds the reviewed budget and minimum through improved fees and rejects material changes", () => {
    const reviewed: LiveQuote = {
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
      estimatedRelayGas: 450000n,
    };
    const improved = {
      ...reviewed,
      relayGas: 400000n,
      estimatedRelayGas: 350000n,
      destinationAmount: 956999n,
    };
    expect(() => {
      assertReviewedFeeCurrent(reviewed, improved);
    }).not.toThrow();
    expect(reviewed.relayGas).toBe(500000n);
    expect(reviewed.destinationAmount).toBe(946999n);
    for (const change of [
      { estimatedRelayGas: 500001n },
      { destinationAmount: 946998n },
      { adapter: TESTNET.token },
      { destination: "base-sepolia" as const },
      { requestedAmount: 10000001n },
    ])
      expect(() => {
        assertReviewedFeeCurrent(reviewed, { ...reviewed, ...change });
      }).toThrow("fresh quote");
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
  it("rejects a stale checkpoint revision after signing and before actual RPC broadcast", async () => {
    const { send } = setup();
    const existing = {
      router: TESTNET.router,
      token: TESTNET.token,
      account: key.publicKey(),
      recipient: "0x" + "1".repeat(40),
      destination: "sepolia" as const,
      route: 1 as const,
      bridgeAmount: "1000000",
      stage: "conversion" as const,
      txHash: "a".repeat(64),
      schemaVersion: 1 as const,
      revision: 1,
    };
    const latest = { ...existing, revision: 2 };
    const raw = JSON.stringify(latest);
    vi.stubGlobal("localStorage", { getItem: () => raw });
    try {
      await expect(
        submitOperation(
          TESTNET.reader,
          new Contract(TESTNET.router).call("noop"),
          sign,
          undefined,
          undefined,
          {
            expectedAccount: key.publicKey(),
            onSigned: (hash) => {
              saveCheckpoint({ ...existing, stage: "bridge", txHash: hash }, existing);
            },
          },
        ),
      ).rejects.toMatchObject({ stage: "checkpoint", txHash: undefined });
      expect(send).not.toHaveBeenCalled();
      expect(localStorage.getItem("hyperion.testnet.pending-transfer")).toBe(raw);
    } finally {
      vi.unstubAllGlobals();
    }
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
    let signedHash: string | undefined;
    let savedHash: string | undefined;
    const wallet = (value: string) => {
      superseded = true;
      signedHash = toHex(TransactionBuilder.fromXdr(value, TESTNET.networkPassphrase).hash()).slice(
        2,
      );
      return sign(value);
    };
    await expect(
      submitSettleClaim(key.publicKey(), 1n, wallet, undefined, {
        expectedAccount: key.publicKey(),
        isSuperseded: () => superseded,
        onSigned: (hash) => {
          savedHash = hash;
        },
      }),
    ).rejects.toThrow("superseded");
    expect(savedHash).toEqual(signedHash);
    expect(savedHash).toMatch(/^[0-9a-f]{64}$/);
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

    it("round-trips generated source amounts and conserves six- and seven-decimal review quotes", () => {
      let state = 0x159c0de;
      const amounts = [
        10_001n,
        10_009n,
        10_010n,
        10_011n,
        10_000_001n,
        ...Array.from({ length: 48 }, () => {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          return BigInt(state) * 100000000n + BigInt(state % 100000000) + 1n;
        }),
      ];
      amounts.push(9007199254740993n);

      const decimalOracle = (units: bigint, decimals: number): string => {
        const scale = 10n ** BigInt(decimals);
        const whole = units / scale;
        const fraction = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
        return fraction ? `${whole}.${fraction}` : whole.toString();
      };

      for (const [index, requestedAmount] of amounts.entries()) {
        const sourceText = decimalOracle(requestedAmount, 7);
        expect(parseSendAmount(sourceText)).toBe(requestedAmount);
        expect(formatUnits(requestedAmount, 7)).toBe(sourceText);
        expect(
          parseBridgeFormParams(
            `?a=${sourceText}&r=0x${"1".repeat(40)}&d=sepolia&t=1&s=native`,
          )?.amount,
        ).toBe(sourceText);

        const quantum = index % 2 === 0 ? 10n : 1n;
        const route = quantum === 10n ? 0 : 1;
        const retainedDust = requestedAmount % quantum;
        const grossAmount = requestedAmount - retainedDust;
        const fee = BigInt(index + 1) * quantum;
        const netAmount = grossAmount - fee;
        const representableAmount = netAmount / quantum;
        const relayGas = route === 0 ? 1n : 0n;
        const destinationAmount = representableAmount - relayGas;
        const quote: LiveQuote = {
          route,
          requestedAmount,
          grossAmount,
          fee,
          netAmount,
          representableAmount,
          destinationAmount,
          relayGas,
          flowAvailable: requestedAmount * 2n,
          ledger: index + 1,
          adapter: TESTNET.router,
          destination: "sepolia",
        };
        const review = quoteBreakdown(quote);

        expect(review.requestedSourceAmount).toBe(requestedAmount);
        expect(review.actualSourceDebit + review.protocolFee + review.retainedDust).toBe(
          requestedAmount,
        );
        expect(review.actualSourceDebit).toBe(grossAmount);
        expect(review.representableBridgeAmount).toBe(netAmount);
        expect(review.representableBridgeAmount / quantum).toBe(representableAmount);
        const destinationDecimals = route === 0 ? 6 : 7;
        expect(destinationAmount).toBe(netAmount / quantum - relayGas);
        expect(formatUnits(destinationAmount, destinationDecimals)).toBe(
          decimalOracle(destinationAmount, destinationDecimals),
        );
      }
    });

    it("rejects amounts with precision beyond seven decimals", () => {
      const invalid = "900719925.47409931";
      expect(() => parseSendAmount(invalid)).toThrow();
      expect(
        parseBridgeFormParams(`?a=${invalid}&r=0x${"1".repeat(40)}&d=sepolia&t=1&s=native`),
      ).toBeNull();
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
    source: { id: XLM.id, code: XLM.code, issuer: XLM.issuer },
  };
  const sameIntent = {
    account: checkpoint.account,
    recipient: checkpoint.recipient,
    source: { id: XLM.id, code: XLM.code, issuer: XLM.issuer },
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
  it("rejects a stale confirmation when recipient or issuer-specific source identity changes", () => {
    expect(checkpointMatches(checkpoint, { ...sameIntent, recipient: "0x" + "b".repeat(40) })).toBe(
      false,
    );
    expect(checkpointMatches(checkpoint, { ...sameIntent, source: USDC })).toBe(false);
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
    source: { id: XLM.id, code: XLM.code, issuer: XLM.issuer },
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
describe("Concurrent and repeated submission boundaries", () => {
  it("retains the signed public hash without automatically requesting another approval after timeout", async () => {
    const { send } = repeatableSetup();
    send.mockRejectedValueOnce(new Error("timeout"));
    const wallet = vi.fn(sign);
    const first = await submitSettleClaim(key.publicKey(), 1n, wallet);
    expect(first.status).toBe("pending");
    expect(first.txHash).toMatch(/^[a-f0-9]{64}$/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(wallet).toHaveBeenCalledTimes(1);
    // Recovery must inspect this hash before any new approval or submission.
  });
  it("keeps two overlapping submissions independent, each with its own explicit wallet approval", async () => {
    const { send } = repeatableSetup();
    let attempt = 0;
    send.mockImplementation((tx) => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error("timeout"));
      return Promise.resolve({
        status: "ERROR",
        hash: toHex(tx.hash()).slice(2),
        latestLedger: 1,
        latestLedgerCloseTime: 1,
      });
    });
    const walletA = vi.fn(sign);
    const walletB = vi.fn(sign);
    const [outcomeA, outcomeB] = await Promise.allSettled([
      submitSettleClaim(key.publicKey(), 1n, walletA),
      submitSettleClaim(key.publicKey(), 1n, walletB),
    ]);
    const outcomes = [outcomeA, outcomeB];
    // Exactly one side of the race lands on the ambiguous pending outcome, and the other is
    // rejected by the network rather than silently merged with, or auto-resubmitted after, it.
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
    const fulfilled = outcomes.find(
      (o): o is PromiseFulfilledResult<Awaited<ReturnType<typeof submitSettleClaim>>> =>
        o.status === "fulfilled",
    );
    expect(fulfilled?.value.status).toBe("pending");
    const rejected = outcomes.find((o): o is PromiseRejectedResult => o.status === "rejected");
    expect((rejected?.reason as Error).message).toMatch("network rejected");
    expect(walletA).toHaveBeenCalledTimes(1);
    expect(walletB).toHaveBeenCalledTimes(1);
  });
});

describe("Binding flow-limit diagnostics", () => {
  it.each([null, -1n, 1n << 127n])(
    "does not invent current capacity from unavailable or invalid values (%s)",
    (available) => {
      const code = sorobanErrorCode("FlowLimitExceeded");
      const diagnostic = describeBindingLimit(code, 10_000_000n, available, "sepolia", 1);
      expect(diagnostic.available).toBeNull();
      expect(diagnostic.summary).toContain("capacity is unavailable");
      expect(diagnostic.nextStep).not.toContain("Reduce the amount");
      expect(diagnostic.nextStep).toContain("Refresh the quote");
    },
  );
  it.each([undefined, null, -1, NaN, Infinity, "", "1.1", "-1", "999999999999999999999999"])(
    "keeps malformed reason %s unclassified",
    (reason) => {
      const diagnostic = describeBindingLimit(reason, 10_000_000n, 0n, "sepolia", 1);
      expect(diagnostic.code).toBeNull();
      expect(diagnostic.kind).toBe("other");
    },
  );
  it("names the exact flow-window headroom and an exact amount to retry", () => {
    const code = sorobanErrorCode("FlowLimitExceeded");
    if (code === null) throw new Error("FlowLimitExceeded has no Soroban tag in this build.");
    const diagnostic = describeBindingLimit(code, 10_000_000n, 2_500_000n, "sepolia", 1);
    expect(diagnostic.kind).toBe("flow");
    expect(diagnostic.available).toBe(2_500_000n);
    expect(diagnostic.requested).toBe(10_000_000n);
    expect(diagnostic.retryable).toBe(true);
    expect(diagnostic.summary).toContain("0.25");
    expect(diagnostic.summary).toContain("Axelar ITS");
    expect(diagnostic.nextStep).toContain("0.25");
    // The Sepolia lane also carries Circle CCTP on this deployment, so it is a real next step.
    expect(diagnostic.alternateLanes.map((lane) => lane.provider)).toEqual(["Circle CCTP"]);
    expect(diagnostic.nextStep).toContain("Circle CCTP");
  });
  it("tells the sender to wait when the flow window has no headroom left at all", () => {
    const code = sorobanErrorCode("FlowLimitExceeded");
    if (code === null) throw new Error("FlowLimitExceeded has no Soroban tag in this build.");
    const diagnostic = describeBindingLimit(code, 5_000_000n, 0n, "sepolia", 1);
    expect(diagnostic.available).toBe(0n);
    expect(diagnostic.nextStep).toContain("fully used");
    expect(diagnostic.nextStep).not.toContain("Reduce the amount");
  });
  it("never offers a lane this testnet deployment does not independently support", () => {
    const code = sorobanErrorCode("FlowLimitExceeded");
    if (code === null) throw new Error("FlowLimitExceeded has no Soroban tag in this build.");
    // Only Sepolia carries Axelar ITS; the Circle CCTP lane on another destination has no
    // alternate lane to offer, and the diagnostic must not invent one.
    const diagnostic = describeBindingLimit(code, 5_000_000n, 1_000_000n, "base-sepolia", 0);
    expect(diagnostic.alternateLanes).toEqual([]);
    expect(diagnostic.nextStep).not.toContain("also supports");
  });
  it("reports the route's maximum transfer cap as non-retryable without inventing a value", () => {
    const code = sorobanErrorCode("ExceedsRouteLimit");
    if (code === null) throw new Error("ExceedsRouteLimit has no Soroban tag in this build.");
    const diagnostic = describeBindingLimit(code, 50_000_000n, 0n, "sepolia", 0);
    expect(diagnostic.kind).toBe("routeMax");
    expect(diagnostic.available).toBeNull();
    expect(diagnostic.retryable).toBe(false);
    expect(diagnostic.nextStep).toContain("Split it into smaller transfers");
  });
  it("marks a liquidity shortfall as retryable and suggests a smaller amount or a wait", () => {
    const code = sorobanErrorCode("InsufficientLiquidity");
    if (code === null) throw new Error("InsufficientLiquidity has no Soroban tag in this build.");
    const diagnostic = describeBindingLimit(code, 50_000_000n, 0n, "sepolia", 0);
    expect(diagnostic.kind).toBe("liquidity");
    expect(diagnostic.retryable).toBe(true);
    expect(diagnostic.nextStep).toContain("liquidity");
  });
  it("composes the thrown error message from the same summary and next step", () => {
    const code = sorobanErrorCode("FlowLimitExceeded");
    if (code === null) throw new Error("FlowLimitExceeded has no Soroban tag in this build.");
    const diagnostic = describeBindingLimit(code, 10_000_000n, 2_500_000n, "sepolia", 1);
    const error = new TransferLimitError(diagnostic);
    expect(error.diagnostic).toBe(diagnostic);
    expect(error.message).toBe(`${diagnostic.summary} ${diagnostic.nextStep}`);
  });
  it("only ever names testnet lanes this deployment actually carries", () => {
    expect(supportedLanes("sepolia").map((lane) => lane.provider)).toEqual([
      "Circle CCTP",
      "Axelar ITS",
    ]);
    for (const destination of ["base-sepolia", "arc-testnet"] as const) {
      expect(supportedLanes(destination).map((lane) => lane.provider)).toEqual(["Circle CCTP"]);
    }
  });
});

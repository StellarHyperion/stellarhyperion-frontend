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
import { STELLAR_DEPLOYMENT, TESTNET } from "../src/config/testnet";
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

    it("does not consult XLM balance on CCTP route", () => {
      // XLM is zero; CCTP does not need it, so max should still be computed.
      const result = planMaxUsdcAmount({
        route: 0,
        usdcSpendable: usdc100,
        xlmSpendable: 0n,
        flowAvailable: flow50,
        estimatedRelayGas: gas1usdc,
      });
      expect(result).toBe(flow50);
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
        xlmSpendable: 0n,
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
      expect(XLM_MINIMUM_RESERVE > 0n).toBe(true);
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

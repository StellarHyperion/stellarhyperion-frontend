import { describe, expect, it } from "vitest";
import { Account, TransactionBuilder, scValToNative } from "@stellar/stellar-sdk";
import { TESTNET } from "../src/config/testnet";
import { bridgeOperation, parseSendAmount, type LiveQuote } from "../src/contracts/stellar";
import {
  MAX_TOKEN_DECIMALS,
  SOROBAN_I128_MAX,
  STELLAR_CLASSIC_MAX,
  formatExactAmount,
  formatTokenAmount,
  getExplorerUrl,
  parseExactAmount,
  shortenAddress,
  shortenTxHash,
  verifyQuoteConservation,
} from "../src/lib/format";
import { relayBudget } from "../src/lib/relay-budget";

const MASK_64 = (1n << 64n) - 1n;

/** Deterministic SplitMix64 generator for reproducible property tests without external dependencies. */
function createSeededGenerator(seed: bigint) {
  let state = seed & MASK_64;
  const nextU64 = (): bigint => {
    state = (state + 0x9e3779b97f4a7c15n) & MASK_64;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK_64;
    return (z ^ (z >> 31n)) & MASK_64;
  };
  const nextInt = (min: number, max: number): number => {
    const span = BigInt(max - min + 1);
    return min + Number(nextU64() % span);
  };
  const nextBigIntBits = (bits: number): bigint => {
    if (bits <= 0) return 0n;
    const high = nextU64();
    const low = nextU64();
    const combined = (high << 64n) | low;
    const mask = (1n << BigInt(bits)) - 1n;
    const candidate = combined & mask;
    return candidate === 0n ? 1n : candidate;
  };
  return { nextU64, nextInt, nextBigIntBits };
}

/** Independent string-slicing decimal oracle that never calls @hyperion/protocol helpers. */
function oracleFormat(amount: bigint, decimals: number): string {
  const digits = amount.toString(10);
  if (decimals === 0) return digits;
  const padded = digits.padStart(decimals + 1, "0");
  const splitAt = padded.length - decimals;
  const whole = padded.slice(0, splitAt);
  const fraction = padded.slice(splitAt).replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

/** Independent decimal string parser oracle using character-level digit accumulation. */
function oracleParse(text: string, decimals: number): bigint {
  const parts = text.split(".");
  if (parts.length > 2) throw new Error("Invalid oracle decimal");
  const whole = parts[0] ?? "";
  const fraction = parts[1] ?? "";
  if (fraction.length > decimals) throw new Error("Excess precision in oracle");
  const combined = `${whole === "" ? "0" : whole}${fraction.padEnd(decimals, "0")}`;
  let acc = 0n;
  for (const ch of combined) {
    const code = ch.charCodeAt(0) - 48;
    if (code < 0 || code > 9) throw new Error("Non-digit in oracle");
    acc = acc * 10n + BigInt(code);
  }
  return acc;
}

describe("Block Explorer Deep Links & Address Formatting", () => {
  it("resolves Stellar testnet transaction and account deep links", () => {
    const txHash = "e2c3b4a5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef12";
    const accountId = "GCHPVETUL5E4YKDLMRIBFUGFK4PMYOVKPFALVSYMP2QDYAVBA3ITQDAI";
    const contractId = "CDMOLDF4SJDEDRWTDF7XAYMSRE6L3YEHHIRF57CFWNQYNC6ZOZ5LWCWF";

    expect(getExplorerUrl("stellar-testnet", "tx", txHash)).toBe(
      `https://stellar.expert/explorer/testnet/tx/${txHash}`,
    );
    expect(getExplorerUrl("stellar-testnet", "address", accountId)).toBe(
      `https://stellar.expert/explorer/testnet/account/${accountId}`,
    );
    expect(getExplorerUrl("stellar-testnet", "address", contractId)).toBe(
      `https://stellar.expert/explorer/testnet/contract/${contractId}`,
    );
  });

  it("resolves Sepolia transaction and address deep links", () => {
    const txHash = "0x4a8f9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90";
    const address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

    expect(getExplorerUrl("sepolia", "tx", txHash)).toBe(
      `https://sepolia.etherscan.io/tx/${txHash}`,
    );
    expect(getExplorerUrl("sepolia", "address", address)).toBe(
      `https://sepolia.etherscan.io/address/${address}`,
    );
    expect(getExplorerUrl("ethereum-sepolia", "tx", txHash)).toBe(
      `https://sepolia.etherscan.io/tx/${txHash}`,
    );
  });

  it("resolves Base Sepolia transaction and address deep links", () => {
    const txHash = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    const address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

    expect(getExplorerUrl("base-sepolia", "tx", txHash)).toBe(
      `https://sepolia.basescan.org/tx/${txHash}`,
    );
    expect(getExplorerUrl("base-sepolia", "address", address)).toBe(
      `https://sepolia.basescan.org/address/${address}`,
    );
  });

  it("resolves Arbitrum Sepolia transaction and address deep links", () => {
    const txHash = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

    expect(getExplorerUrl("arbitrum-sepolia", "tx", txHash)).toBe(
      `https://sepolia.arbiscan.io/tx/${txHash}`,
    );
    expect(getExplorerUrl("arbitrum-sepolia", "address", address)).toBe(
      `https://sepolia.arbiscan.io/address/${address}`,
    );
  });

  it("resolves Arc testnet transaction and address deep links", () => {
    const txHash = "0xdeadbeef1234567890abcdef";
    const address = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";

    expect(getExplorerUrl("arc-testnet", "tx", txHash)).toBe(
      `https://explorer.testnet.arc.io/tx/${txHash}`,
    );
    expect(getExplorerUrl("arc-testnet", "address", address)).toBe(
      `https://explorer.testnet.arc.io/address/${address}`,
    );
  });

  it("formats and shortens addresses and transaction hashes cleanly", () => {
    expect(shortenAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")).toBe("0x7099...dc79C8");
    expect(shortenAddress("GCHPVETUL5E4YKDLMRIBFUGFK4PMYOVKPFALVSYMP2QDYAVBA3ITQDAI")).toBe(
      "GCHPVE...ITQDAI",
    );
    expect(shortenAddress("short")).toBe("short");
    expect(shortenAddress("")).toBe("");

    expect(
      shortenTxHash("0x4a8f9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90"),
    ).toBe("0x4a8f9b1c...6d7e8f90");
    expect(shortenTxHash("short-hash")).toBe("short-hash");
  });
});

describe("Exact-amount rendering and conservation property tests", () => {
  it("preserves exactness across 128-bit integer boundaries and decimal scales against an independent oracle", () => {
    const rng = createSeededGenerator(100_001n);
    const decimalsUnderTest = [0, 6, 7, 18, MAX_TOKEN_DECIMALS];
    const boundaryAmounts: bigint[] = [
      1n,
      2n,
      9n,
      10n,
      11n,
      99n,
      100n,
      9_999_999n,
      10_000_000n,
      10_000_001n,
      BigInt(Number.MAX_SAFE_INTEGER) - 1n,
      BigInt(Number.MAX_SAFE_INTEGER),
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      BigInt(Number.MAX_SAFE_INTEGER) + 2n,
      STELLAR_CLASSIC_MAX - 1n,
      STELLAR_CLASSIC_MAX,
      STELLAR_CLASSIC_MAX + 1n,
      SOROBAN_I128_MAX - 1n,
      SOROBAN_I128_MAX,
    ];

    for (let i = 0; i < 250; i += 1) {
      const bitWidth = rng.nextInt(1, 127);
      boundaryAmounts.push(rng.nextBigIntBits(bitWidth));
    }

    for (const decimals of decimalsUnderTest) {
      expect(formatExactAmount(0n, decimals)).toBe("0");
      expect(formatTokenAmount("0", decimals)).toBe("0");

      for (const amount of boundaryAmounts) {
        const expected = oracleFormat(amount, decimals);
        const rendered = formatExactAmount(amount, decimals);
        const tokenRendered = formatTokenAmount(amount.toString(10), decimals);

        expect(rendered).toBe(expected);
        expect(tokenRendered).toBe(expected);
        expect(rendered).not.toMatch(/[eE]/);

        // Lossless bijection back to exact integer units.
        expect(parseExactAmount(rendered, decimals)).toBe(amount);
        expect(oracleParse(rendered, decimals)).toBe(amount);

        if (decimals === 7) {
          expect(parseSendAmount(rendered)).toBe(amount);
        }
      }
    }

    expect(formatTokenAmount("0004200", null)).toBe("4200 base units");
    expect(formatTokenAmount("9007199254740993", undefined)).toBe("9007199254740993 base units");
  });

  it("conserves seven-to-six-decimal boundaries and preserves exact XDR signing intent", () => {
    const rng = createSeededGenerator(200_002n);
    const recipient = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

    // Explicit 7-to-6 stroop remainder boundaries (0 through 9 stroops) plus large 127-bit values.
    const amounts: bigint[] = [];
    for (let remainder = 0n; remainder <= 9n; remainder += 1n) {
      amounts.push(10_000_000n + remainder);
      amounts.push(BigInt(Number.MAX_SAFE_INTEGER) + remainder);
      amounts.push(STELLAR_CLASSIC_MAX - remainder);
    }
    for (let i = 0; i < 180; i += 1) {
      const bits = rng.nextInt(24, 120);
      amounts.push(rng.nextBigIntBits(bits));
    }

    for (const grossAmount of amounts) {
      const feeBps = BigInt(rng.nextInt(0, 250));
      const fee = (grossAmount * feeBps) / 10_000n;
      const netAmount = grossAmount - fee;
      const circleForwardMed = BigInt(rng.nextInt(1, 50_000));
      const cctpRelayGas = relayBudget(circleForwardMed) * 10n;
      const itsRelayGas = relayBudget(BigInt(rng.nextInt(10_000, 5_000_000)));

      // Route 1: Axelar ITS keeps 7 decimals end-to-end; XLM gas never reduces USDC output.
      const itsQuote: LiveQuote = {
        route: 1,
        adapter: TESTNET.router,
        destination: "sepolia",
        requestedAmount: grossAmount,
        grossAmount,
        fee,
        netAmount,
        destinationAmount: netAmount,
        flowAvailable: SOROBAN_I128_MAX,
        ledger: 100,
        relayGas: itsRelayGas,
      };
      const itsSnapshot = { ...itsQuote };
      const itsReport = verifyQuoteConservation({
        route: 1,
        grossAmount: itsQuote.grossAmount,
        fee: itsQuote.fee,
        netAmount: itsQuote.netAmount,
        destinationAmount: itsQuote.destinationAmount,
        relayGas: itsQuote.relayGas,
      });

      expect(itsReport.valid).toBe(true);
      expect(itsReport.destinationDecimals).toBe(7);
      expect(itsReport.subUnitRemainderStroops).toBe(0n);
      expect(itsQuote).toEqual(itsSnapshot);
      expect(oracleParse(itsReport.formatted.grossAmount, 7)).toBe(grossAmount);
      expect(oracleParse(itsReport.formatted.destinationAmount, 7)).toBe(netAmount);

      const itsOp = bridgeOperation(TESTNET.reader, itsQuote, recipient);
      const itsTx = new TransactionBuilder(new Account(TESTNET.reader, "0"), {
        fee: "100",
        networkPassphrase: TESTNET.networkPassphrase,
      })
        .addOperation(itsOp)
        .setTimeout(60)
        .build();
      const decodedItsOp = TransactionBuilder.fromXdr(itsTx.toXdr(), TESTNET.networkPassphrase)
        .operations[0];
      if (
        decodedItsOp?.type !== "invokeHostFunction" ||
        decodedItsOp.func.type !== "hostFunctionTypeInvokeContract"
      ) {
        throw new Error("Expected invokeContract operation for ITS quote.");
      }
      const itsArgs = decodedItsOp.func.invokeContract.args;
      if (!itsArgs[1] || !itsArgs[2]) throw new Error("Missing encoded ITS arguments.");
      const decodedItsReq = scValToNative(itsArgs[1]) as {
        amount: bigint;
        destination_decimals: number;
        min_destination_amount: bigint;
      };
      expect(decodedItsReq.amount).toBe(grossAmount);
      expect(decodedItsReq.destination_decimals).toBe(7);
      expect(decodedItsReq.min_destination_amount).toBe(netAmount);
      expect(scValToNative(itsArgs[2])).toBe(itsRelayGas);

      // Route 0: Circle CCTP scales 7-decimal Stellar USDC to 6-decimal native EVM USDC.
      if (cctpRelayGas < netAmount && netAmount / 10n > cctpRelayGas / 10n) {
        const expectedSixDecimalOut = netAmount / 10n - cctpRelayGas / 10n;
        const cctpQuote: LiveQuote = {
          route: 0,
          adapter: TESTNET.router,
          destination: "sepolia",
          requestedAmount: grossAmount,
          grossAmount,
          fee,
          netAmount,
          destinationAmount: expectedSixDecimalOut,
          flowAvailable: SOROBAN_I128_MAX,
          ledger: 100,
          relayGas: cctpRelayGas,
        };
        const cctpSnapshot = { ...cctpQuote };
        const cctpReport = verifyQuoteConservation({
          route: 0,
          grossAmount: cctpQuote.grossAmount,
          fee: cctpQuote.fee,
          netAmount: cctpQuote.netAmount,
          destinationAmount: cctpQuote.destinationAmount,
          relayGas: cctpQuote.relayGas,
        });

        expect(cctpReport.valid).toBe(true);
        expect(cctpReport.destinationDecimals).toBe(6);
        expect(cctpReport.subUnitRemainderStroops).toBe(netAmount % 10n);
        expect(cctpQuote).toEqual(cctpSnapshot);

        // Independent conservation identity in 7-decimal stroops:
        expect(cctpQuote.destinationAmount * 10n + cctpQuote.relayGas + (netAmount % 10n)).toBe(
          netAmount,
        );
        expect(cctpQuote.fee + netAmount).toBe(grossAmount);
        expect(oracleParse(cctpReport.formatted.destinationAmount, 6)).toBe(expectedSixDecimalOut);

        const cctpOp = bridgeOperation(TESTNET.reader, cctpQuote, recipient);
        const cctpTx = new TransactionBuilder(new Account(TESTNET.reader, "0"), {
          fee: "100",
          networkPassphrase: TESTNET.networkPassphrase,
        })
          .addOperation(cctpOp)
          .setTimeout(60)
          .build();
        const decodedCctpOp = TransactionBuilder.fromXdr(cctpTx.toXdr(), TESTNET.networkPassphrase)
          .operations[0];
        if (
          decodedCctpOp?.type !== "invokeHostFunction" ||
          decodedCctpOp.func.type !== "hostFunctionTypeInvokeContract"
        ) {
          throw new Error("Expected invokeContract operation for CCTP quote.");
        }
        const cctpArgs = decodedCctpOp.func.invokeContract.args;
        if (!cctpArgs[1] || !cctpArgs[2]) throw new Error("Missing encoded CCTP arguments.");
        const decodedCctpReq = scValToNative(cctpArgs[1]) as {
          amount: bigint;
          destination_decimals: number;
          min_destination_amount: bigint;
        };
        expect(decodedCctpReq.amount).toBe(grossAmount);
        expect(decodedCctpReq.destination_decimals).toBe(6);
        expect(decodedCctpReq.min_destination_amount).toBe(expectedSixDecimalOut);
        expect(scValToNative(cctpArgs[2])).toBe(cctpRelayGas);
      } else {
        // Sub-fee or sub-unit quotes must never be marked eligible for signing.
        const rejectedReport = verifyQuoteConservation({
          route: 0,
          grossAmount,
          fee,
          netAmount,
          destinationAmount: 0n,
          relayGas: cctpRelayGas,
        });
        expect(rejectedReport.valid).toBe(false);
      }
    }

    // Sub-unit 7-decimal amounts (1..9 stroops) and unaligned Circle relay budgets are rejected.
    for (let dust = 1n; dust <= 9n; dust += 1n) {
      expect(
        verifyQuoteConservation({
          route: 0,
          grossAmount: dust + 10n,
          fee: 0n,
          netAmount: dust + 10n,
          destinationAmount: 0n,
          relayGas: 10n,
        }).valid,
      ).toBe(false);
    }
    expect(
      verifyQuoteConservation({
        route: 0,
        grossAmount: 10_000_000n,
        fee: 0n,
        netAmount: 10_000_000n,
        destinationAmount: 999_999n,
        relayGas: 15n,
      }).valid,
    ).toBe(false);
  });

  it("rejects invalid precision, non-canonical strings, and out-of-range amounts without silent rounding", () => {
    const rng = createSeededGenerator(300_003n);

    // Generated over-precise strings (including trailing zeros beyond allowed decimals) must fail.
    for (const decimals of [0, 6, 7, 18]) {
      for (let i = 0; i < 60; i += 1) {
        const whole = rng.nextBigIntBits(rng.nextInt(1, 40)).toString(10);
        const extraDigits = rng.nextInt(1, 6);
        const tailDigit = i % 2 === 0 ? "0" : String(rng.nextInt(1, 9));
        const overPrecise = `${whole}.${"0".repeat(decimals)}${"0".repeat(extraDigits - 1)}${tailDigit}`;

        expect(() => parseExactAmount(overPrecise, decimals)).toThrow();
        if (decimals === 7) {
          expect(() => parseSendAmount(overPrecise)).toThrow();
        }
      }
    }

    const malformedInputs = [
      "",
      "   ",
      "0",
      "0.0",
      "0.0000000",
      "-1",
      "+1",
      "1e7",
      "1E-7",
      "1,000",
      "1_000",
      "0x10",
      "NaN",
      "Infinity",
      ".",
      "1.2.3",
      (SOROBAN_I128_MAX + 1n).toString(10),
    ];

    for (const bad of malformedInputs) {
      expect(() => parseExactAmount(bad, 7)).toThrow();
      expect(() => parseSendAmount(bad)).toThrow();
    }

    // Stellar Classic bound check via custom maxAmount.
    expect(
      parseExactAmount(formatExactAmount(STELLAR_CLASSIC_MAX, 7), 7, STELLAR_CLASSIC_MAX),
    ).toBe(STELLAR_CLASSIC_MAX);
    expect(() =>
      parseExactAmount(formatExactAmount(STELLAR_CLASSIC_MAX + 1n, 7), 7, STELLAR_CLASSIC_MAX),
    ).toThrow();

    // Invalid decimal scales never crash or round silently in formatTokenAmount.
    for (const badDecimals of [-1, -7, 39, 78, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatTokenAmount("10000000", badDecimals)).toBe("unavailable");
      expect(() => formatExactAmount(10_000_000n, badDecimals)).toThrow();
      expect(() => parseExactAmount("1", badDecimals)).toThrow();
    }

    for (const badRaw of ["", "-100", "1.5", "1e5", "abc", "100n", " 100 "]) {
      expect(formatTokenAmount(badRaw, 7)).toBe("unavailable");
    }
  });
});

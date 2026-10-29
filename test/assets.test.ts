import { afterEach, describe, expect, it, vi } from "vitest";
import { Account, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  quoteConversion,
  conversionOperations,
  searchAssets,
  stellarAsset,
  USDC,
  XLM,
} from "../src/contracts/assets";
import { parseCheckpoint, type TransferCheckpoint } from "../src/contracts/checkpoint";
import { TESTNET } from "../src/config/testnet";
import { relayBudget } from "../src/lib/relay-budget";
afterEach(() => {
  vi.unstubAllGlobals();
});
const path = {
  source_asset_type: "native",
  source_amount: "1.0000000",
  destination_asset_code: USDC.code,
  destination_asset_issuer: USDC.issuer,
  destination_amount: "0.8000000",
  path: [],
};
const answer = (records: unknown[]) => {
  const request = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ _embedded: { records } }), { status: 200 }));
  vi.stubGlobal("fetch", request);
  return request;
};
describe("Real Stellar conversion transaction boundaries", () => {
  it("uses live liquidity and keeps the conversion within the exact source maximum", async () => {
    const request = answer([path, { ...path, destination_amount: "0.9000000" }]);
    const conversion = await quoteConversion(XLM, 10000000n);
    expect(request.mock.calls[0]?.[0]).toContain("source_amount=1");
    expect(conversion.usdcAmount).toBe(8955000n);
    const tx = new TransactionBuilder(new Account(TESTNET.reader, "1"), {
      fee: "100",
      networkPassphrase: TESTNET.networkPassphrase,
    });
    for (const operation of conversionOperations(TESTNET.reader, conversion, true))
      tx.addOperation(operation);
    const decoded = TransactionBuilder.fromXdr(
      tx.setTimeout(60).build().toXdr(),
      TESTNET.networkPassphrase,
    );
    expect(decoded.operations[0]?.type).toBe("changeTrust");
    const payment = decoded.operations[1];
    if (payment?.type !== "pathPaymentStrictReceive")
      throw new Error("Missing conversion operation.");
    expect(payment.sendMax).toBe("1.0000000");
    expect(payment.destAmount).toBe("0.8955000");
    expect(payment.destination).toBe(TESTNET.reader);
    expect(payment.destAsset.getIssuer()).toBe(USDC.issuer);
  });
  it("never invents a route when liquidity or the canonical receiving asset is absent", async () => {
    answer([]);
    await expect(quoteConversion(XLM, 10000000n)).rejects.toThrow("No liquid");
    answer([{ ...path, destination_asset_issuer: TESTNET.reader }]);
    await expect(quoteConversion(XLM, 10000000n)).rejects.toThrow("No liquid");
  });
  it("keeps issuer identity and rejects invalid assets or oversized source amounts", async () => {
    expect(() => stellarAsset({ ...USDC, id: "USDC:different" })).toThrow();
    expect(() => stellarAsset({ ...USDC, issuer: "invalid" })).toThrow();
    const fetcher = answer([]);
    await expect(quoteConversion(XLM, 1n << 63n)).rejects.toThrow("limit");
    await expect(searchAssets("not a valid asset code")).rejects.toThrow("Search by");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
describe("Interrupted transfer recovery", () => {
  const checkpoint: TransferCheckpoint = {
    router: TESTNET.router,
    account: TESTNET.reader,
    recipient: `0x${"1".repeat(40)}`,
    destination: "sepolia",
    route: 1,
    bridgeAmount: "1000000",
    stage: "conversion",
    txHash: "a".repeat(64),
  };
  it("preserves a real conversion hash and the intended second leg", () => {
    expect(parseCheckpoint(JSON.stringify(checkpoint))).toEqual(checkpoint);
  });
  it.each([
    { router: "different" },
    { account: "invalid" },
    { destination: "ethereum" },
    { route: 3 },
    { stage: "unknown" },
    { bridgeAmount: "0" },
    { txHash: "fake" },
    { recipient: `0x${"0".repeat(40)}` },
  ])("refuses a corrupted recovery record %j", (change) => {
    expect(parseCheckpoint(JSON.stringify({ ...checkpoint, ...change }))).toBeNull();
  });
});
describe("Live relay fee headroom", () => {
  it("rounds upward without losing precision or introducing token dust", () => {
    expect(relayBudget(1n)).toBe(2n);
    expect(relayBudget(842780n, 10n)).toBe(927060n);
    expect(relayBudget(9007199254740993n)).toBe(9907919180215093n);
    expect(() => relayBudget(0n)).toThrow();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { Account, Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  quoteConversion,
  accountAssets,
  accountTrustlineReserve,
  trustlineReservePreview,
  trustlineReserveImpact,
  submitConversion,
  type Conversion,
  type SourceAsset,
  conversionExecutionIntent,
  conversionRoute,
  conversionOperations,
  compareConversionPaths,
  MAX_CONVERSION_PATHS,
  isCanonicalUsdc,
  revalidateConversion,
  issuerVerificationLabel,
  minimumXlmReserve,
  quoteTrade,
  searchAssets,
  spendableBalance,
  spendableXlm,
  stellarAsset,
  suggestSourceSpend,
  USDC,
  XLM,
  trustlineLabel,
  xlmShortfall,
} from "../src/contracts/assets";
import {
  checkpointForAsset,
  parseCheckpoint,
  type TransferCheckpoint,
} from "../src/contracts/checkpoint";
import {
  DESTINATIONS,
  deploymentIdentityMismatch,
  STELLAR_DEPLOYMENT,
  TESTNET,
} from "../src/config/testnet";
import { relayBudget } from "../src/lib/relay-budget";
import { createReviewedIntentSnapshot } from "../src/contracts/stellar";
afterEach(() => {
  vi.unstubAllGlobals();
});
const path = {
  source_asset_type: "native",
  source_amount: "1.0000000",
  destination_asset_type: "credit_alphanum4",
  destination_asset_code: USDC.code,
  destination_asset_issuer: USDC.issuer,
  destination_amount: "0.8000000",
  path: [],
};
const pathComparison = (selectedOutput: bigint) => ({
  returnedPaths: 1,
  eligiblePaths: 1,
  selectedOutput,
  excludedPaths: 0,
  diagnostics: [],
  omittedDiagnostics: 0,
});
const answer = (records: unknown[]) => {
  const request = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ _embedded: { records } }), { status: 200 }));
  vi.stubGlobal("fetch", request);
  return request;
};
describe("Real Stellar conversion transaction boundaries", () => {
  it("uses live liquidity and keeps the conversion within the exact source maximum", async () => {
    const request = answer([
      path,
      { ...path, destination_amount: "0.9000000" },
      { ...path, path: [{ asset_type: "unsupported" }] },
    ]);
    const conversion = await quoteConversion(XLM, 10000000n);
    expect(request.mock.calls[0]?.[0]).toContain("source_amount=1");
    expect(request.mock.calls[0]?.[0]).toContain(`limit=${MAX_CONVERSION_PATHS}`);
    expect(conversion.usdcAmount).toBe(8955000n);
    expect(conversion.pathComparison.selectedOutput).toBe(9000000n);
    expect(conversion.pathComparison).toMatchObject({
      returnedPaths: 3,
      eligiblePaths: 2,
      excludedPaths: 1,
      diagnostics: [{ responseIndex: 2, reason: "path asset 1 has an unsupported asset type." }],
    });
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
  it("exposes the exact route and execution intent used to assemble the transaction", () => {
    const issuer = Keypair.random().publicKey();
    const intermediate = {
      id: `USD:${issuer}`,
      code: "USD",
      issuer,
      verification: "horizon-path" as const,
      trustline: "not-checked" as const,
    };
    const conversion = {
      source: XLM,
      sourceMax: 10000000n,
      usdcAmount: 8955000n,
      path: [intermediate],
      pathComparison: pathComparison(9000000n),
    };
    const intent = conversionExecutionIntent(conversion, true);
    expect(intent).toMatchObject({
      operation: "pathPaymentStrictReceive",
      sourceMax: 10000000n,
      destinationAmount: 8955000n,
      addTrustline: true,
      path: [intermediate],
    });
    expect(conversionRoute(conversion)).toEqual([XLM, intermediate, USDC]);
    const operations = conversionOperations(TESTNET.reader, conversion, true);
    expect(operations).toHaveLength(2);
    const tx = new TransactionBuilder(new Account(TESTNET.reader, "1"), {
      fee: "100",
      networkPassphrase: TESTNET.networkPassphrase,
    });
    for (const operation of operations) tx.addOperation(operation);
    const decoded = TransactionBuilder.fromXdr(
      tx.setTimeout(60).build().toXdr(),
      TESTNET.networkPassphrase,
    );
    const payment = decoded.operations[1];
    if (payment?.type !== "pathPaymentStrictReceive")
      throw new Error("Missing conversion operation.");
    expect(payment.sendMax).toBe("1.0000000");
    expect(payment.destAmount).toBe("0.8955000");
    expect(payment.path).toHaveLength(1);
    expect(payment.path[0]?.getIssuer()).toBe(issuer);
  });
  it("never invents a route when liquidity or the canonical receiving asset is absent", async () => {
    answer([]);
    await expect(quoteConversion(XLM, 10000000n)).rejects.toThrow("No liquid");
    answer([{ ...path, destination_asset_issuer: TESTNET.reader }]);
    await expect(quoteConversion(XLM, 10000000n)).rejects.toThrow("No liquid");
    answer([{ ...path, source_amount: "0.9000000" }]);
    await expect(quoteConversion(XLM, 10000000n)).rejects.toThrow(
      "Path 1: source amount does not match the requested spend cap.",
    );
  });
  it("excludes malformed and source-mismatched paths with bounded diagnostics", () => {
    const result = compareConversionPaths(XLM, 10000000n, [
      { ...path, source_amount: "0.9000000" },
      { ...path, destination_amount: "not-an-amount" },
      { ...path, path: [{ asset_type: "unsupported" }] },
      { ...path },
    ]);
    expect(result.selected?.output).toBe(8000000n);
    expect(result.eligiblePaths).toBe(1);
    expect(result.excludedPaths).toBe(3);
    expect(result.diagnostics.map(({ reason }) => reason)).toEqual([
      "source amount does not match the requested spend cap.",
      "destination amount is not a valid exact 7-decimal amount.",
      "path asset 1 has an unsupported asset type.",
    ]);
  });
  it("matches issued source paths by both code and issuer", () => {
    const source = {
      id: `USD:${TESTNET.reader}`,
      code: "USD",
      issuer: TESTNET.reader,
      verification: "horizon-search" as const,
      trustline: "present" as const,
    };
    const result = compareConversionPaths(source, 10000000n, [
      {
        ...path,
        source_asset_type: "credit_alphanum4",
        source_asset_code: source.code,
        source_asset_issuer: USDC.issuer,
      },
      {
        ...path,
        source_asset_type: "credit_alphanum4",
        source_asset_code: source.code,
        source_asset_issuer: source.issuer,
      },
    ]);
    expect(result.eligiblePaths).toBe(1);
    expect(result.excludedPaths).toBe(1);
    expect(result.diagnostics[0]?.reason).toBe(
      "source code or issuer does not match the requested asset.",
    );
  });
  it("selects equal-output paths by issuer-qualified identity, regardless of Horizon order", () => {
    const issuerA = Keypair.random().publicKey();
    const issuerB = Keypair.random().publicKey();
    const first = {
      ...path,
      destination_amount: "0.9000000",
      path: [{ asset_type: "credit_alphanum4", asset_code: "USD", asset_issuer: issuerA }],
    };
    const second = {
      ...path,
      destination_amount: "0.9000000",
      path: [{ asset_type: "credit_alphanum4", asset_code: "USD", asset_issuer: issuerB }],
    };
    const forward = compareConversionPaths(XLM, 10000000n, [first, second]);
    const reversed = compareConversionPaths(XLM, 10000000n, [second, first]);
    expect(forward.selected).toEqual(reversed.selected);
    expect(forward.selected?.path[0]?.issuer).toBe([issuerA, issuerB].sort()[0]);
  });
  it("excludes oversized amount strings and issued identity attached to native path assets", () => {
    const result = compareConversionPaths(XLM, 10000000n, [
      { ...path, destination_amount: "9".repeat(100000) },
      {
        ...path,
        path: [{ asset_type: "native", asset_code: "USD", asset_issuer: TESTNET.reader }],
      },
      path,
    ]);
    expect(result.eligiblePaths).toBe(1);
    expect(result.excludedPaths).toBe(2);
    expect(result.diagnostics.map(({ reason }) => reason)).toEqual([
      "destination amount is not a valid exact 7-decimal amount.",
      "path asset 1 includes issued-asset identity fields on a native asset.",
    ]);
    expect(result.selected?.output).toBe(8000000n);
  });
  it("rejects a response that exceeds the bounded comparison limit", () => {
    const result = compareConversionPaths(
      XLM,
      10000000n,
      Array.from({ length: MAX_CONVERSION_PATHS + 1 }, () => path),
    );
    expect(result.selected).toBeNull();
    expect(result.excludedPaths).toBe(MAX_CONVERSION_PATHS + 1);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.reason).toContain("comparison limit");
  });
  it("rechecks live liquidity without changing reviewed conversion bounds", async () => {
    const reviewed = {
      source: XLM,
      sourceMax: 10000000n,
      usdcAmount: 8000000n,
      path: [],
      pathComparison: pathComparison(8000000n),
    };
    answer([
      {
        ...path,
        destination_amount: "0.8100000",
        path: [
          {
            asset_type: "credit_alphanum4",
            asset_code: "EUR",
            asset_issuer: USDC.issuer,
          },
        ],
      },
    ]);
    await expect(revalidateConversion(reviewed)).rejects.toThrow("conversion path changed");
    answer([{ ...path, destination_amount: "0.8100000", path: [] }]);
    expect(await revalidateConversion(reviewed)).toBe(reviewed);
    answer([{ ...path, destination_amount: "0.8000000" }]);
    await expect(revalidateConversion(reviewed)).rejects.toThrow("reviewed USDC minimum");
    answer([]);
    await expect(revalidateConversion(reviewed)).rejects.toThrow("No liquid");
  });
  it("keeps issuer identity and rejects invalid assets or oversized source amounts", async () => {
    expect(() => stellarAsset({ ...USDC, id: "USDC:different" })).toThrow();
    expect(() => stellarAsset({ ...USDC, issuer: "invalid" })).toThrow();
    expect(isCanonicalUsdc(USDC)).toBe(true);
    const sameCodeDifferentIssuer = {
      ...USDC,
      id: `USDC:${TESTNET.reader}`,
      issuer: TESTNET.reader,
      verification: "horizon-search" as const,
      trustline: "not-checked" as const,
    };
    expect(isCanonicalUsdc(sameCodeDifferentIssuer)).toBe(false);
    const request = answer([
      {
        ...path,
        source_asset_type: "credit_alphanum4",
        source_asset_code: sameCodeDifferentIssuer.code,
        source_asset_issuer: sameCodeDifferentIssuer.issuer,
      },
    ]);
    const conversion = await quoteConversion(sameCodeDifferentIssuer, 10000000n);
    const params = new URL(String(request.mock.calls[0]?.[0])).searchParams;
    expect(params.get("source_asset_issuer")).toBe(TESTNET.reader);
    expect(params.get("destination_assets")).toBe(USDC.id);
    expect(conversion.source).toEqual(sameCodeDifferentIssuer);
    const fetcher = answer([]);
    await expect(quoteConversion(XLM, 1n << 63n)).rejects.toThrow("limit");
    await expect(searchAssets("not a valid asset code")).rejects.toThrow("Search by");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps same-symbol assets distinct and marks Horizon issuer metadata for review", async () => {
    answer([
      { asset_code: "USDC", asset_issuer: USDC.issuer },
      { asset_code: "USDC", asset_issuer: TESTNET.reader },
    ]);
    const assets = await searchAssets("USDC");
    expect(assets.map((asset) => asset.id)).toEqual([
      `${USDC.code}:${USDC.issuer}`,
      `USDC:${TESTNET.reader}`,
    ]);
    expect(assets.every((asset) => asset.verification === "horizon-search")).toBe(true);
    expect(assets.every((asset) => asset.trustline === "not-checked")).toBe(true);
    const first = assets[0];
    if (!first) throw new Error("Missing searched asset.");
    expect(issuerVerificationLabel(first)).toContain("verify before signing");
    expect(trustlineLabel(first)).toBe("Trustline not checked for this asset");
  });
  it("records an authorized wallet trustline as present without calling it configured", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          balances: [
            {
              asset_type: "credit_alphanum4",
              asset_code: "USDC",
              asset_issuer: USDC.issuer,
              balance: "2.0000000",
              is_authorized: true,
            },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", request);
    const asset = (await accountAssets(TESTNET.reader))[0];
    if (!asset) throw new Error("Missing wallet asset.");
    expect(asset).toMatchObject({
      id: USDC.id,
      verification: "wallet-trustline",
      trustline: "present",
    });
    expect(issuerVerificationLabel(asset)).toContain("verify before signing");
  });
  it("computes spendable balance by subtracting selling liabilities from total balance", () => {
    const issuer = Keypair.random().publicKey();
    const asset = {
      id: `TEST:${issuer}`,
      code: "TEST",
      issuer,
      verification: "wallet-trustline" as const,
      trustline: "present" as const,
      balance: "100.0000000",
      sellingLiabilities: "25.0000000",
    };
    expect(spendableBalance(asset)).toBe("75.0000000");
    expect(suggestSourceSpend(asset)).toBe("75.0000000");

    const fullyCommitted = { ...asset, sellingLiabilities: "100.0000000" };
    expect(spendableBalance(fullyCommitted)).toBe("0.0000000");
    expect(suggestSourceSpend(fullyCommitted)).toBe("0.0000000");

    const overCommitted = { ...asset, sellingLiabilities: "105.0000000" };
    expect(spendableBalance(overCommitted)).toBe("0.0000000");
    expect(suggestSourceSpend(overCommitted)).toBe("0.0000000");

    const noLiabilities = {
      id: asset.id,
      code: asset.code,
      issuer: asset.issuer,
      verification: asset.verification,
      trustline: asset.trustline,
      balance: asset.balance,
    };
    expect(spendableBalance(noLiabilities)).toBe("100.0000000");
    expect(suggestSourceSpend(noLiabilities)).toBe("100.0000000");
  });
  it("suggested source spend does not exceed available issued-asset balance", async () => {
    const issuer = Keypair.random().publicKey();
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          balances: [
            {
              asset_type: "credit_alphanum4",
              asset_code: "USDC",
              asset_issuer: USDC.issuer,
              balance: "50.0000000",
              selling_liabilities: "20.0000000",
              is_authorized: true,
            },
            {
              asset_type: "credit_alphanum4",
              asset_code: "WRAP",
              asset_issuer: issuer,
              balance: "10.0000000",
              selling_liabilities: "10.0000000",
              is_authorized: true,
            },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", request);
    const assets = await accountAssets(TESTNET.reader);
    const usdc = assets.find((a) => a.id === USDC.id);
    const wrap = assets.find((a) => a.code === "WRAP");
    if (!usdc || !wrap) throw new Error("Missing wallet assets.");

    expect(usdc.balance).toBe("50.0000000");
    expect(usdc.sellingLiabilities).toBe("20.0000000");
    expect(usdc.available).toBe("30.0000000");
    expect(suggestSourceSpend(usdc)).toBe("30.0000000");

    expect(wrap.balance).toBe("10.0000000");
    expect(wrap.sellingLiabilities).toBe("10.0000000");
    expect(wrap.available).toBe("0.0000000");
    expect(suggestSourceSpend(wrap)).toBe("0.0000000");
  });
  it("frozen or unauthorized trustlines block conversion with a clear reason", async () => {
    const issuer = Keypair.random().publicKey();
    const response = new Response(
      JSON.stringify({
        balances: [
          {
            asset_type: "credit_alphanum4",
            asset_code: "FROZ",
            asset_issuer: issuer,
            balance: "100.0000000",
            is_authorized: false,
            is_authorized_to_maintain_liabilities: true,
          },
          {
            asset_type: "credit_alphanum4",
            asset_code: "UNAT",
            asset_issuer: issuer,
            balance: "50.0000000",
            is_authorized: false,
            is_authorized_to_maintain_liabilities: false,
          },
          {
            asset_type: "credit_alphanum4",
            asset_code: "LIAB",
            asset_issuer: issuer,
            balance: "20.0000000",
            selling_liabilities: "15.0000000",
            is_authorized: true,
          },
        ],
      }),
    );
    const request = vi.fn().mockImplementation(() => Promise.resolve(response.clone()));
    vi.stubGlobal("fetch", request);
    const assets = await accountAssets(TESTNET.reader);
    const froz = assets.find((a) => a.code === "FROZ");
    const unat = assets.find((a) => a.code === "UNAT");
    const liab = assets.find((a) => a.code === "LIAB");
    if (!froz || !unat || !liab) throw new Error("Missing wallet assets.");

    expect(froz.trustline).toBe("frozen");
    expect(froz.available).toBe("0.0000000");
    expect(trustlineLabel(froz)).toBe("Trustline frozen by issuer");
    expect(suggestSourceSpend(froz)).toBe("0.0000000");

    expect(unat.trustline).toBe("unauthorized");
    expect(unat.available).toBe("0.0000000");
    expect(trustlineLabel(unat)).toBe("Trustline not authorized by issuer");
    expect(suggestSourceSpend(unat)).toBe("0.0000000");

    expect(liab.trustline).toBe("present");
    expect(liab.available).toBe("5.0000000");
    expect(liab.sellingLiabilities).toBe("15.0000000");
    expect(suggestSourceSpend(liab)).toBe("5.0000000");

    await expect(quoteConversion(froz, 10000000n)).rejects.toThrow(
      "Trustline for FROZ is frozen by the issuer.",
    );
    await expect(quoteConversion(unat, 10000000n)).rejects.toThrow(
      "Trustline for UNAT is not authorized by the issuer.",
    );

    await expect(quoteTrade("sepolia", froz, "1.0", 1)).rejects.toThrow(
      "Trustline for FROZ is frozen by the issuer.",
    );
    await expect(quoteTrade("sepolia", unat, "1.0", 1)).rejects.toThrow(
      "Trustline for UNAT is not authorized by the issuer.",
    );

    const dummySigner = vi.fn();
    const frozConversion = {
      source: froz,
      sourceMax: 10000000n,
      usdcAmount: 9000000n,
      path: [],
      pathComparison: pathComparison(9000000n),
    };
    await expect(submitConversion(TESTNET.reader, frozConversion, dummySigner)).rejects.toThrow(
      "Trustline for FROZ is frozen by the issuer.",
    );

    const unatConversion = {
      source: unat,
      sourceMax: 10000000n,
      usdcAmount: 9000000n,
      path: [],
      pathComparison: pathComparison(9000000n),
    };
    await expect(submitConversion(TESTNET.reader, unatConversion, dummySigner)).rejects.toThrow(
      "Trustline for UNAT is not authorized by the issuer.",
    );

    const liabConversion = {
      source: liab,
      sourceMax: 60000000n,
      usdcAmount: 50000000n,
      path: [],
      pathComparison: pathComparison(50000000n),
    };
    await expect(submitConversion(TESTNET.reader, liabConversion, dummySigner)).rejects.toThrow(
      "Insufficient available LIAB balance. Selling liabilities reduce your spendable balance to 5.0000000 LIAB.",
    );
  });
  it("decimal strings remain exact through calculation and rendering", () => {
    const issuer = Keypair.random().publicKey();
    const asset = {
      id: `EXACT:${issuer}`,
      code: "EXACT",
      issuer,
      verification: "wallet-trustline" as const,
      trustline: "present" as const,
      balance: "9999999.1234567",
      sellingLiabilities: "0.0000001",
    };
    expect(spendableBalance(asset)).toBe("9999999.1234566");
    expect(suggestSourceSpend(asset)).toBe("9999999.1234566");

    const precisionAsset = {
      ...asset,
      balance: "0.0000002",
      sellingLiabilities: "0.0000001",
    };
    expect(spendableBalance(precisionAsset)).toBe("0.0000001");
    expect(suggestSourceSpend(precisionAsset)).toBe("0.0000001");
  });
});
describe("Independently verified testnet bridge lanes", () => {
  it("binds the configured Stellar asset identity to the checked-in deployment", () => {
    expect(STELLAR_DEPLOYMENT).toMatchObject({
      usdcCode: USDC.code,
      usdcIssuer: USDC.issuer,
      usdcToken: TESTNET.token,
    });
    expect(
      deploymentIdentityMismatch(STELLAR_DEPLOYMENT.router, STELLAR_DEPLOYMENT.usdcToken),
    ).toBeNull();
    expect(deploymentIdentityMismatch("different-router", STELLAR_DEPLOYMENT.usdcToken)).toContain(
      "router",
    );
    expect(deploymentIdentityMismatch(STELLAR_DEPLOYMENT.router, "different-token")).toContain(
      "USDC token contract",
    );
  });
  it("exposes only the routes backed by checked-in delivery evidence", () => {
    expect(Object.fromEntries(DESTINATIONS.map(({ key, routes }) => [key, routes]))).toEqual({
      sepolia: [0, 1],
      "base-sepolia": [0],
      "arc-testnet": [0],
    });
  });
});
describe("Trustline reserve and network fee disclosure", () => {
  it("uses observed base reserve and liabilities, rejecting invalid reserve counters", () => {
    const reserve = trustlineReservePreview(40000000n, 2, 1, 1, 6000000n, 10000000n);
    expect(reserve.currentMinimumBalance).toBe(24000000n);
    expect(reserve.availableAfterTrustline).toBe(0n);
    expect(() => trustlineReservePreview(40000000n, Number.NaN)).toThrow(/Invalid/);
    expect(() => trustlineReservePreview(40000000n, 2.5)).toThrow(/Invalid/);
    expect(() => trustlineReservePreview(40000000n, 0, 0, 9)).toThrow(/Invalid/);
  });

  it("reads the account reserve needed for an atomic trustline from real Horizon balances", async () => {
    // Horizon's account resource has no top-level `balance` field; the native balance lives in
    // `balances` alongside every other trustline, exactly like a real funded testnet account.
    const request = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          subentry_count: 2,
          num_sponsoring: 0,
          num_sponsored: 0,
          balances: [
            {
              asset_type: "credit_alphanum4",
              asset_code: "USDC",
              asset_issuer: USDC.issuer,
              balance: "0.0000000",
              is_authorized: true,
            },
            { asset_type: "native", balance: "3.0000000" },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", request);
    request.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ _embedded: { records: [{ base_reserve_in_stroops: 5000000 }] } }),
      ),
    );
    await expect(accountTrustlineReserve(TESTNET.reader)).resolves.toMatchObject({
      nativeBalance: 30000000n,
      currentMinimumBalance: 20000000n,
      trustlineReserve: 5000000n,
      availableAfterTrustline: 5000000n,
    });
    expect(trustlineReservePreview(30000000n, 2).availableAfterTrustline).toBe(5000000n);
  });
  it("refuses an account response with no native balance entry instead of reading undefined", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ subentry_count: 0, balances: [] }))),
    );
    await expect(accountTrustlineReserve(TESTNET.reader)).rejects.toThrow(
      "Invalid Stellar account reserve data.",
    );
  });
  it("refuses to invent sponsorship counts for the pre-sign trustline reserve check", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              input.includes("/ledgers")
                ? { _embedded: { records: [{ base_reserve_in_stroops: "5000000" }] } }
                : {
                    subentry_count: 0,
                    num_sponsoring: "0",
                    num_sponsored: 0,
                    balances: [{ asset_type: "native", balance: "10.0000000" }],
                  },
            ),
          ),
        ),
      ),
    );
    await expect(accountTrustlineReserve(TESTNET.reader)).rejects.toThrow(
      "Invalid Stellar account reserve data.",
    );
  });
});
describe("Trustline reserve and network fee disclosure", () => {
  const foo: SourceAsset = {
    id: `FOO:${USDC.issuer}`,
    code: "FOO",
    issuer: USDC.issuer,
    verification: "wallet-trustline",
    trustline: "present",
  };
  it("locks a trustline reserve and the signed transaction's network fee out of spendable XLM", () => {
    const conversion: Conversion = {
      source: foo,
      sourceMax: 3000000n,
      usdcAmount: 2000000n,
      path: [],
      pathComparison: pathComparison(2000000n),
    };
    const exact = trustlineReserveImpact(trustlineReservePreview(20000200n, 1), conversion, true);
    expect(exact.addsTrustline).toBe(true);
    expect(exact.networkFee).toBe(200n);
    expect(exact.sourceSpend).toBe(0n);
    expect(exact.projectedSpendable).toBe(0n);
    const oneStroopShort = trustlineReserveImpact(
      trustlineReservePreview(20000199n, 1),
      conversion,
      true,
    );
    expect(oneStroopShort.projectedSpendable).toBe(-1n);
  });
  it("also counts the XLM a conversion itself spends when the source asset is XLM", () => {
    const conversion: Conversion = {
      source: XLM,
      sourceMax: 30000000n,
      usdcAmount: 2000000n,
      path: [],
      pathComparison: pathComparison(2000000n),
    };
    const impact = trustlineReserveImpact(trustlineReservePreview(50000200n, 0), conversion, true);
    expect(impact.sourceSpend).toBe(30000000n);
    expect(impact.projectedSpendable).toBe(5000000n);
  });
  it("skips the second reserve and the second operation fee once the trustline already exists", () => {
    const conversion: Conversion = {
      source: foo,
      sourceMax: 1n,
      usdcAmount: 1n,
      path: [],
      pathComparison: pathComparison(1n),
    };
    const impact = trustlineReserveImpact(trustlineReservePreview(10000100n, 1), conversion, false);
    expect(impact.addsTrustline).toBe(false);
    expect(impact.networkFee).toBe(100n);
    expect(impact.projectedSpendable).toBe(-5000000n);
  });
  it("refuses to ask the wallet to sign when the reserve for the combined transaction is short", async () => {
    // submitConversion reads the account twice (once for the source balance, once for the
    // reserve), so each fetch call needs its own Response body rather than one reused instance.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) =>
        url.includes("/ledgers?")
          ? Promise.resolve(
              new Response(
                JSON.stringify({ _embedded: { records: [{ base_reserve_in_stroops: 5000000 }] } }),
              ),
            )
          : new Response(
              JSON.stringify({
                subentry_count: 1,
                num_sponsoring: 0,
                num_sponsored: 0,
                balances: [
                  { asset_type: "native", balance: "2.0000199" },
                  {
                    asset_type: "credit_alphanum4",
                    asset_code: foo.code,
                    asset_issuer: foo.issuer,
                    balance: "5.0000000",
                    is_authorized: true,
                  },
                ],
              }),
            ),
      ),
    );
    const conversion: Conversion = {
      source: foo,
      sourceMax: 1000000n,
      usdcAmount: 900000n,
      path: [],
      pathComparison: pathComparison(900000n),
    };
    const sign = vi.fn(() => Promise.resolve({ signedTxXdr: "unused" }));
    await expect(submitConversion(TESTNET.reader, conversion, sign)).rejects.toThrow(/reserve/i);
    expect(sign).not.toHaveBeenCalled();
  });
});
describe("Interrupted transfer recovery", () => {
  const checkpoint: TransferCheckpoint = {
    router: TESTNET.router,
    token: TESTNET.token,
    account: TESTNET.reader,
    recipient: `0x${"1".repeat(40)}`,
    destination: "sepolia",
    route: 1,
    bridgeAmount: "1000000",
    stage: "conversion",
    txHash: "a".repeat(64),
    source: { id: XLM.id, code: XLM.code, issuer: XLM.issuer },
  };
  it("preserves a real conversion hash, the intended second leg and the originating asset", () => {
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
    { source: null },
    { source: { id: "FAKE", code: "FAKE", issuer: null } },
    { source: { id: USDC.id, code: USDC.code, issuer: TESTNET.reader } },
  ])("refuses a corrupted recovery record %j", (change) => {
    expect(parseCheckpoint(JSON.stringify({ ...checkpoint, ...change }))).toBeNull();
  });
  it("never lets a conversion-only checkpoint stand in for a completed cross-chain transfer", () => {
    const conversionOnly = parseCheckpoint(JSON.stringify({ ...checkpoint, stage: "conversion" }));
    expect(conversionOnly?.stage).toBe("conversion");
    expect(conversionOnly?.stage).not.toBe("bridge");
  });
  it("never lets a newly selected asset reuse another asset's converted-USDC recovery data", () => {
    expect(checkpointForAsset(parseCheckpoint(JSON.stringify(checkpoint)), XLM)).toEqual(
      checkpoint,
    );
    expect(checkpointForAsset(parseCheckpoint(JSON.stringify(checkpoint)), USDC)).toBeNull();
    expect(checkpointForAsset(null, USDC)).toBeNull();
  });
});
describe("Spendable XLM accounts for reserves and fees", () => {
  it("computes the minimum reserve and spendable figures with exact stroop arithmetic", () => {
    // (2 base entries + 3 subentries + 1 sponsoring - 0 sponsored) * 5,000,000 stroop reserve.
    expect(minimumXlmReserve(3, 1, 0, 5000000n)).toBe(30000000n);
    expect(minimumXlmReserve(0, 0, 1, 5000000n)).toBe(5000000n);
    expect(minimumXlmReserve(0, 0, 2, 5000000n)).toBe(0n);
    expect(() => minimumXlmReserve(0, 0, 3, 5000000n)).toThrow(
      "Invalid Stellar reserve accounting.",
    );
    expect(() => minimumXlmReserve(Number.MAX_SAFE_INTEGER, 0, 0, 5000000n)).toThrow();
    expect(() => spendableXlm(-1n, 0n, 0n, 1n)).toThrow();
    expect(spendableXlm(100000000n, 1000000n, 30000000n, 200n)).toBe(68999800n);
    // Never goes negative: a balance already below the reserve and fee margin clamps to zero.
    expect(spendableXlm(1000000n, 0n, 30000000n, 200n)).toBe(0n);
  });
  it("never assumes safety when the spendable figure is unconfirmed", () => {
    expect(xlmShortfall(undefined, 100n)).toBe("unknown");
    // available alone, without a confirmed nativeMinimumReserve, is not trusted.
    expect(xlmShortfall({ ...XLM, available: "0.0000100" }, 100n)).toBe("unknown");
    const confirmed = {
      ...XLM,
      balance: "3.0000300",
      nativeMinimumReserve: "3.0000000",
      nativeFeeMargin: "0.0000200",
      available: "0.0000100",
    };
    expect(xlmShortfall(confirmed, 0n)).toBe("ok");
    expect(xlmShortfall(confirmed, 100n)).toBe("ok");
    expect(xlmShortfall(confirmed, 101n)).toBe("insufficient");
  });
  it("derives spendable XLM from live balances, liabilities and the account's real reserve count", async () => {
    const request = vi.fn((input: string) => {
      if (input.includes("/ledgers"))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              _embedded: {
                records: [{ base_fee_in_stroops: 100, base_reserve_in_stroops: 5000000 }],
              },
            }),
            { status: 200 },
          ),
        );
      return Promise.resolve(
        new Response(
          JSON.stringify({
            subentry_count: 4,
            num_sponsoring: 0,
            num_sponsored: 0,
            balances: [
              { asset_type: "native", balance: "100.0000000", selling_liabilities: "1.0000000" },
              {
                asset_type: "credit_alphanum4",
                asset_code: "FOO",
                asset_issuer: TESTNET.reader,
                balance: "5.0000000",
              },
            ],
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal("fetch", request);
    const assets = await accountAssets(TESTNET.reader);
    const native = assets.find((asset) => asset.id === XLM.id);
    // balance 100 - liabilities 1 - reserve (2+4)*0.5 = 3 - fee margin 2*0.00001 = 95.99998 XLM
    expect(native?.nativeMinimumReserve).toBe("3.0000000");
    expect(native?.nativeFeeMargin).toBe("0.0000200");
    expect(native?.available).toBe("95.9999800");
    expect(assets.find((asset) => asset.code === "FOO")?.balance).toBe("5.0000000");
  });
  it("surfaces unknown reserve information explicitly instead of defaulting to the raw balance", async () => {
    const request = vi.fn((input: string) => {
      if (input.includes("/ledgers")) return Promise.resolve(new Response("", { status: 503 }));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            subentry_count: 0,
            num_sponsoring: 0,
            num_sponsored: 0,
            balances: [{ asset_type: "native", balance: "50.0000000" }],
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal("fetch", request);
    const assets = await accountAssets(TESTNET.reader);
    const native = assets.find((asset) => asset.id === XLM.id);
    expect(native?.nativeMinimumReserve).toBeUndefined();
    expect(native?.available).toBe("0.0000000");
    expect(native?.balance).toBe("50.0000000");
  });
  it.each([
    { num_sponsoring: undefined },
    { num_sponsoring: "0" },
    { num_sponsored: null },
    { num_sponsored: -1 },
    { num_sponsored: 0.5 },
    { subentry_count: Number.MAX_SAFE_INTEGER },
    { num_sponsored: 3 },
  ])("keeps malformed account reserve metadata unknown: %j", async (change) => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              input.includes("/ledgers")
                ? {
                    _embedded: {
                      records: [{ base_fee_in_stroops: 100, base_reserve_in_stroops: 5000000 }],
                    },
                  }
                : {
                    subentry_count: 0,
                    num_sponsoring: 0,
                    num_sponsored: 0,
                    ...change,
                    balances: [{ asset_type: "native", balance: "10.0000000" }],
                  },
            ),
          ),
        ),
      ),
    );
    const native = (await accountAssets(TESTNET.reader))[0];
    expect(native?.balance).toBe("10.0000000");
    expect(native?.nativeMinimumReserve).toBeUndefined();
    expect(native?.available).toBe("0.0000000");
    expect(xlmShortfall(native, 0n)).toBe("unknown");
  });
  it.each([undefined, 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "100.5", "4294967296"])(
    "keeps invalid live fees unknown even for a zero relay gas budget: %s",
    async (baseFee) => {
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string) =>
          Promise.resolve(
            new Response(
              JSON.stringify(
                input.includes("/ledgers")
                  ? {
                      _embedded: {
                        records: [
                          { base_fee_in_stroops: baseFee, base_reserve_in_stroops: 5000000 },
                        ],
                      },
                    }
                  : {
                      subentry_count: 0,
                      num_sponsoring: 0,
                      num_sponsored: 0,
                      balances: [{ asset_type: "native", balance: "10.0000000" }],
                    },
              ),
            ),
          ),
        ),
      );
      const native = (await accountAssets(TESTNET.reader))[0];
      expect(native?.nativeFeeMargin).toBeUndefined();
      expect(xlmShortfall(native, 0n)).toBe("unknown");
    },
  );
  it.each([1, 2])(
    "uses exact string ledger parameters for an account with %s sponsored base entries",
    async (sponsored) => {
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string) =>
          Promise.resolve(
            new Response(
              JSON.stringify(
                input.includes("/ledgers")
                  ? {
                      _embedded: {
                        records: [
                          { base_fee_in_stroops: "100", base_reserve_in_stroops: "5000000" },
                        ],
                      },
                    }
                  : {
                      subentry_count: 0,
                      num_sponsoring: 0,
                      num_sponsored: sponsored,
                      balances: [{ asset_type: "native", balance: "1.0000000" }],
                    },
              ),
            ),
          ),
        ),
      );
      const native = (await accountAssets(TESTNET.reader))[0];
      expect(native?.nativeMinimumReserve).toBe(sponsored === 1 ? "0.5000000" : "0.0000000");
      expect(native?.available).toBe(sponsored === 1 ? "0.4999800" : "0.9999800");
      expect(xlmShortfall(native, 0n)).toBe("ok");
    },
  );
  it("does not let a clamped zero balance hide an unpaid network fee", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              input.includes("/ledgers")
                ? {
                    _embedded: {
                      records: [{ base_fee_in_stroops: 100, base_reserve_in_stroops: 5000000 }],
                    },
                  }
                : {
                    subentry_count: 0,
                    num_sponsoring: 0,
                    num_sponsored: 0,
                    balances: [{ asset_type: "native", balance: "1.0000199" }],
                  },
            ),
          ),
        ),
      ),
    );
    const native = (await accountAssets(TESTNET.reader))[0];
    expect(native?.available).toBe("0.0000000");
    expect(native?.nativeFeeMargin).toBe("0.0000200");
    expect(xlmShortfall(native, 0n)).toBe("insufficient");
  });
  it("keeps malformed native liabilities unknown instead of treating them as zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              input.includes("/ledgers")
                ? {
                    _embedded: {
                      records: [{ base_fee_in_stroops: 100, base_reserve_in_stroops: 5000000 }],
                    },
                  }
                : {
                    subentry_count: 0,
                    num_sponsoring: 0,
                    num_sponsored: 0,
                    balances: [
                      { asset_type: "native", balance: "10.0000000", selling_liabilities: 1 },
                    ],
                  },
            ),
          ),
        ),
      ),
    );
    const native = (await accountAssets(TESTNET.reader))[0];
    expect(native?.nativeFeeMargin).toBeUndefined();
    expect(xlmShortfall(native, 0n)).toBe("unknown");
  });
  it("propagates cancellation during the ledger read", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        if (input.includes("/ledgers")) {
          controller.abort();
          return Promise.reject(new Error("Ledger read canceled."));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              subentry_count: 0,
              num_sponsoring: 0,
              num_sponsored: 0,
              balances: [{ asset_type: "native", balance: "10.0000000" }],
            }),
          ),
        );
      }),
    );
    await expect(accountAssets(TESTNET.reader, controller.signal)).rejects.toThrow(
      "Ledger read canceled.",
    );
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

describe("Native reserve-aware balances", () => {
  it("subtracts live subentry and sponsorship reserves before suggesting spendable XLM", async () => {
    const payload = {
      subentry_count: 20,
      num_sponsoring: 2,
      num_sponsored: 4,
      balances: [{ asset_type: "native", balance: "12.0000000", selling_liabilities: "1.0000000" }],
    };
    const ledger = {
      _embedded: {
        records: [{ base_fee_in_stroops: 100, base_reserve_in_stroops: 5000000 }],
      },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(payload)))
      .mockResolvedValueOnce(new Response(JSON.stringify(ledger)));
    vi.stubGlobal("fetch", fetcher);
    const native = (await accountAssets(TESTNET.reader))[0];
    expect(native?.nativeMinimumReserve).toBe("10.0000000");
    // 12 - 1 liability - 10 reserve - fee margin (2 * 0.00001) = 0.9999800.
    expect(native?.available).toBe("0.9999800");
  });
  it("does not invent native spendable funds when reserve metadata is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ balances: [{ asset_type: "native", balance: "99.0000000" }] }),
          ),
        ),
    );
    expect((await accountAssets(TESTNET.reader))[0]?.available).toBe("0.0000000");
  });
});

describe("Horizon search cancellation", () => {
  it("forwards the abort signal to the Horizon fetch", async () => {
    const captured: AbortSignal[] = [];
    const request = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) throw new Error("The Horizon fetch must carry an abort signal.");
      captured.push(signal);
      return Promise.resolve(
        new Response(JSON.stringify({ _embedded: { records: [] } }), { status: 200 }),
      );
    });
    vi.stubGlobal("fetch", request);
    const controller = new AbortController();
    await searchAssets("USDC", controller.signal);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBeDefined();
    vi.unstubAllGlobals();
  });
  it("rejects a stale search when its signal is aborted", async () => {
    const stored: { resolve: (value: Response) => void; signal: AbortSignal }[] = [];
    const request = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("The Horizon fetch must carry an abort signal."));
            return;
          }
          const onAbort = () => {
            reject(new Error("The search was aborted."));
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          stored.push({ resolve, signal });
        }),
    );
    vi.stubGlobal("fetch", request);
    const controller = new AbortController();
    const promise = searchAssets("USDC", controller.signal);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.signal).toBeDefined();
    controller.abort();
    await expect(promise).rejects.toThrow("The search was aborted.");
    vi.unstubAllGlobals();
  });
  it("lets the current query complete while an older aborted search does not replace it", async () => {
    const stored: { resolve: (value: Response) => void; signal: AbortSignal }[] = [];
    const request = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("The Horizon fetch must carry an abort signal."));
            return;
          }
          const onAbort = () => {
            reject(new Error("The search was aborted."));
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          stored.push({ resolve, signal });
        }),
    );
    vi.stubGlobal("fetch", request);
    const olderController = new AbortController();
    const currentController = new AbortController();
    const older = searchAssets("USDC", olderController.signal);
    const current = searchAssets("ABC", currentController.signal);
    expect(stored).toHaveLength(2);
    olderController.abort();
    await expect(older).rejects.toThrow("The search was aborted.");
    const body = JSON.stringify({
      _embedded: { records: [{ asset_code: USDC.code, asset_issuer: USDC.issuer }] },
    });
    const currentResponse = stored[1];
    if (!currentResponse) throw new Error("Missing the current search response.");
    currentResponse.resolve(new Response(body, { status: 200 }));
    const assets = await current;
    expect(assets.map((asset) => asset.id)).toEqual([USDC.id]);
    vi.unstubAllGlobals();
  });
});
describe("Live Stellar liquidity acceptance proof schema", () => {
  // Explicit opt-in only: reads real Stellar Testnet Horizon liquidity, never signs or spends.
  // Normal checks stay credential-free and skip this suite.
  const liveEnabled = process.env.HYPERION_LIVE_TESTNET === "1";
  it.skipIf(!liveEnabled)(
    "keeps issuer-specific USDC identity and exact integer amounts on a real liquid path",
    async () => {
      vi.unstubAllGlobals();
      const amount = 10000000n;
      const conversion = await quoteConversion(XLM, amount);
      expect(conversion.sourceMax).toBe(amount);
      expect(conversion.usdcAmount).toBeGreaterThan(0n);
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
      const payment = decoded.operations.find(
        (operation) => operation.type === "pathPaymentStrictReceive",
      );
      if (payment?.type !== "pathPaymentStrictReceive")
        throw new Error("Missing conversion operation.");
      // Issuer-specific token identity: the real liquid path must still resolve to the exact
      // canonical USDC issuer, never a different asset that merely shares the USDC code.
      expect(payment.destAsset.getIssuer()).toBe(USDC.issuer);
      // Exact integer amounts: Stellar's classic amount strings never carry scientific notation
      // or extra rounding beyond the fixed seven decimal places.
      expect(payment.sendMax).toMatch(/^\d+\.\d{7}$/);
      expect(payment.destAmount).toMatch(/^\d+\.\d{7}$/);
    },
    30_000,
  );
});

describe("Reviewed conversion submission", () => {
  it("refuses changed exact spend, output or issuer identity before reading account data or asking the wallet", async () => {
    const account = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(22)).publicKey();
    const conversion: Conversion = {
      source: XLM,
      sourceMax: 10000000n,
      usdcAmount: 8000000n,
      path: [],
      pathComparison: {
        returnedPaths: 1,
        eligiblePaths: 1,
        selectedOutput: 8100000n,
        excludedPaths: 0,
        diagnostics: [],
        omittedDiagnostics: 0,
      },
    };
    const intent = createReviewedIntentSnapshot({
      account,
      asset: XLM,
      destination: "sepolia",
      route: 1,
      recipient: "0x" + "1".repeat(40),
      amount: conversion.usdcAmount,
      sourceDebit: conversion.usdcAmount,
      protocolFee: 30000n,
      netAmount: 7970000n,
      representableAmount: 7970000n,
      adapter: TESTNET.router,
      minimum: 7970000n,
      providerBudget: 100n,
      estimatedProviderBudget: 80n,
      sourceAmount: conversion.sourceMax,
      sourceMaximum: conversion.sourceMax,
      stage: "conversion",
    });
    const fetchRead = vi.fn();
    vi.stubGlobal("fetch", fetchRead);
    const wallet = vi.fn();
    for (const change of [
      { sourceMax: conversion.sourceMax + 1n },
      { usdcAmount: conversion.usdcAmount - 1n },
      { source: USDC },
    ]) {
      await expect(
        submitConversion(account, { ...conversion, ...change }, wallet, undefined, undefined, {
          expectedAccount: account,
          reviewedIntent: intent,
        }),
      ).rejects.toThrow("reviewed conversion intent changed");
    }
    expect(fetchRead).not.toHaveBeenCalled();
    expect(wallet).not.toHaveBeenCalled();
  });
});

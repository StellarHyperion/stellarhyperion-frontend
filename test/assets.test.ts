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
  revalidateConversion,
  issuerVerificationLabel,
  quoteTrade,
  searchAssets,
  spendableBalance,
  stellarAsset,
  suggestSourceSpend,
  USDC,
  XLM,
  trustlineLabel,
} from "../src/contracts/assets";
import { parseCheckpoint, type TransferCheckpoint } from "../src/contracts/checkpoint";
import { DESTINATIONS, TESTNET } from "../src/config/testnet";
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
  });
  it("rechecks live liquidity without changing reviewed conversion bounds", async () => {
    const reviewed = { source: XLM, sourceMax: 10000000n, usdcAmount: 8000000n, path: [] };
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
    };
    await expect(submitConversion(TESTNET.reader, frozConversion, dummySigner)).rejects.toThrow(
      "Trustline for FROZ is frozen by the issuer.",
    );

    const unatConversion = {
      source: unat,
      sourceMax: 10000000n,
      usdcAmount: 9000000n,
      path: [],
    };
    await expect(submitConversion(TESTNET.reader, unatConversion, dummySigner)).rejects.toThrow(
      "Trustline for UNAT is not authorized by the issuer.",
    );

    const liabConversion = {
      source: liab,
      sourceMax: 60000000n,
      usdcAmount: 50000000n,
      path: [],
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
    };
    const impact = trustlineReserveImpact(trustlineReservePreview(50000200n, 0), conversion, true);
    expect(impact.sourceSpend).toBe(30000000n);
    expect(impact.projectedSpendable).toBe(5000000n);
  });
  it("skips the second reserve and the second operation fee once the trustline already exists", () => {
    const conversion: Conversion = { source: foo, sourceMax: 1n, usdcAmount: 1n, path: [] };
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
    };
    const sign = vi.fn(() => Promise.resolve({ signedTxXdr: "unused" }));
    await expect(submitConversion(TESTNET.reader, conversion, sign)).rejects.toThrow(/reserve/i);
    expect(sign).not.toHaveBeenCalled();
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

describe("Native reserve-aware balances", () => {
  it("subtracts live subentry and sponsorship reserves before suggesting spendable XLM", async () => {
    const payload = {
      subentry_count: 20,
      num_sponsoring: 2,
      num_sponsored: 4,
      balances: [{ asset_type: "native", balance: "12.0000000", selling_liabilities: "1.0000000" }],
    };
    const ledger = { _embedded: { records: [{ base_reserve_in_stroops: 5000000 }] } };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(payload)))
      .mockResolvedValueOnce(new Response(JSON.stringify(ledger)));
    vi.stubGlobal("fetch", fetcher);
    const native = (await accountAssets(TESTNET.reader))[0];
    expect(native?.nativeMinimumReserve).toBe("10.0000000");
    expect(native?.available).toBe("1.0000000");
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

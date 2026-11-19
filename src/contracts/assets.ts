import { Asset, BASE_FEE, Operation, StrKey, type xdr } from "@stellar/stellar-sdk";
import { formatUnits, parseUnits } from "@hyperion/protocol";
import {
  TESTNET,
  cachedPublicAssetMetadata,
  getPublicAssetMetadata,
  type PublicAssetMetadata,
  type BridgeRoute,
  type DestinationKey,
} from "../config/testnet";
import {
  quoteTransfer,
  submitClassicOperations,
  type LiveQuote,
  type SubmissionReconciliation,
  type TransactionPhase,
  type TransactionResult,
  type WalletSigner,
} from "./stellar";
import type { WalletApprovalProvenance } from "../wallets/stellar/types";

export interface SourceAsset {
  id: string;
  code: string;
  issuer: string | null;
  verification: AssetVerification;
  trustline: TrustlineState;
  balance?: string;
  sellingLiabilities?: string;
  available?: string;
  nativeMinimumReserve?: string;
  metadata?: PublicAssetMetadata;
}
export type AssetVerification =
  "configured" | "wallet-trustline" | "horizon-search" | "horizon-path" | "cached-metadata";
export type TrustlineState = "native" | "present" | "not-checked" | "frozen" | "unauthorized";
export interface TrustlineReservePreview {
  readonly nativeBalance: bigint;
  readonly sellingLiabilities: bigint;
  readonly baseReserve: bigint;
  readonly currentMinimumBalance: bigint;
  readonly trustlineReserve: bigint;
  readonly availableAfterTrustline: bigint;
}
export const STELLAR_BASE_RESERVE = 5000000n;

export const XLM: SourceAsset = {
  id: "native",
  code: "XLM",
  issuer: null,
  verification: "configured",
  trustline: "native",
};
export const USDC: SourceAsset = {
  id: `${TESTNET.usdcCode}:${TESTNET.usdcIssuer}`,
  code: TESTNET.usdcCode,
  issuer: TESTNET.usdcIssuer,
  verification: "configured",
  trustline: "not-checked",
};
export const SLIPPAGE_BPS = 50n;

export function issuerVerificationLabel(asset: SourceAsset): string {
  if (!asset.issuer) return "Native Stellar asset; no issuer";
  if (asset.verification === "cached-metadata")
    return asset.metadata?.stale
      ? "Cached issuer metadata is stale; verify before signing"
      : "Cached issuer metadata; verify before signing";
  if (asset.verification === "configured") return "Issuer matches the configured testnet asset";
  return "Issuer metadata supplied by Horizon; verify before signing";
}

export function trustlineLabel(asset: SourceAsset): string {
  switch (asset.trustline) {
    case "native":
      return "Native balance";
    case "present":
      return "Wallet trustline present";
    case "frozen":
      return "Trustline frozen by issuer";
    case "unauthorized":
      return "Trustline not authorized by issuer";
    default:
      return "Trustline not checked for this asset";
  }
}

function formatSpendableUnits(units: bigint): string {
  const scale = 10_000_000n;
  return `${units / scale}.${(units % scale).toString().padStart(7, "0")}`;
}

export function spendableBalance(asset: SourceAsset): string {
  if (asset.trustline === "frozen" || asset.trustline === "unauthorized") {
    return "0.0000000";
  }
  if (!asset.balance) return "0.0000000";
  const balanceUnits = parseUnits(asset.balance, 7);
  const liabilitiesUnits = asset.sellingLiabilities ? parseUnits(asset.sellingLiabilities, 7) : 0n;
  const availableUnits = balanceUnits > liabilitiesUnits ? balanceUnits - liabilitiesUnits : 0n;
  return formatSpendableUnits(availableUnits);
}

export function suggestSourceSpend(asset: SourceAsset): string {
  return spendableBalance(asset);
}

export function stellarAsset(asset: SourceAsset): Asset {
  if (asset.id === "native" && asset.issuer === null && asset.code === "XLM") return Asset.native();
  if (
    !asset.issuer ||
    !StrKey.isValidEd25519PublicKey(asset.issuer) ||
    !/^[A-Za-z0-9]{1,12}$/.test(asset.code) ||
    asset.id !== `${asset.code}:${asset.issuer}`
  )
    throw new Error("Choose a valid Stellar asset and issuer.");
  return new Asset(asset.code, asset.issuer);
}

async function horizon(path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(`${TESTNET.horizonUrl}${path}`, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
    cache: "no-store",
  });
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? "This Stellar account is not funded yet."
        : "Stellar asset discovery is unavailable. Try again.",
    );
  const body: unknown = await response.json();
  if (!body || typeof body !== "object") throw new Error("Invalid Stellar asset response.");
  return body as Record<string, unknown>;
}

export function trustlineReservePreview(
  nativeBalance: bigint,
  subentryCount: number,
  numSponsoring = 0,
  numSponsored = 0,
  baseReserve = STELLAR_BASE_RESERVE,
  sellingLiabilities = 0n,
): TrustlineReservePreview {
  if (
    nativeBalance < 0n ||
    sellingLiabilities < 0n ||
    baseReserve <= 0n ||
    ![subentryCount, numSponsoring, numSponsored].every((v) => Number.isSafeInteger(v) && v >= 0) ||
    2 + subentryCount + numSponsoring - numSponsored < 0
  )
    throw new Error("Invalid Stellar reserve data.");
  const currentMinimumBalance =
    BigInt(2 + subentryCount + numSponsoring - numSponsored) * baseReserve;
  const trustlineReserve = baseReserve;
  return {
    nativeBalance,
    sellingLiabilities,
    baseReserve,
    currentMinimumBalance,
    trustlineReserve,
    availableAfterTrustline:
      nativeBalance - sellingLiabilities - currentMinimumBalance - trustlineReserve,
  };
}

export async function accountTrustlineReserve(
  account: string,
  signal?: AbortSignal,
): Promise<TrustlineReservePreview> {
  if (!StrKey.isValidEd25519PublicKey(account)) throw new Error("Invalid Stellar account.");
  const body = await horizon(`/accounts/${account}`, signal);
  if (!Array.isArray(body.balances) || typeof body.subentry_count !== "number")
    throw new Error("Invalid Stellar account reserve data.");
  // Horizon's account resource has no top-level `balance`; the native balance is the entry in
  // `balances` whose `asset_type` is "native". Reading it from the wrong place would silently
  // read `undefined` and never reflect a real account's actual lumens.
  const native = body.balances.find(
    (entry): entry is { asset_type: string; balance: string } =>
      !!entry &&
      typeof entry === "object" &&
      (entry as Record<string, unknown>).asset_type === "native" &&
      typeof (entry as Record<string, unknown>).balance === "string",
  );
  if (!native) throw new Error("Invalid Stellar account reserve data.");
  const ledger = records(await horizon("/ledgers?order=desc&limit=1", signal))[0];
  if (
    !ledger ||
    !Number.isSafeInteger(ledger.base_reserve_in_stroops) ||
    Number(ledger.base_reserve_in_stroops) <= 0
  )
    throw new Error("The current Stellar base reserve is unavailable.");
  const selling = (native as unknown as Record<string, unknown>).selling_liabilities;
  if (selling !== undefined && typeof selling !== "string")
    throw new Error("Invalid Stellar liabilities.");
  return trustlineReservePreview(
    parseUnits(native.balance, 7),
    body.subentry_count,
    typeof body.num_sponsoring === "number" ? body.num_sponsoring : 0,
    typeof body.num_sponsored === "number" ? body.num_sponsored : 0,
    BigInt(Number(ledger.base_reserve_in_stroops)),
    selling === undefined ? 0n : parseUnits(selling, 7),
  );
}

export interface TrustlineReserveImpact extends TrustlineReservePreview {
  readonly addsTrustline: boolean;
  readonly networkFee: bigint;
  readonly sourceSpend: bigint;
  readonly projectedSpendable: bigint;
}

// The reserve preview above is account-only (what a new trustline would lock up). This folds in
// the specific conversion about to be signed: the network fee for the combined transaction (one
// operation per signature when no trustline is needed, two when it is) and, when the source asset
// being spent is XLM itself, the exact integer amount that pathPaymentStrictReceive can take as
// sendMax. Both come out of the same spendable XLM the trustline reserve just locked into.
export function trustlineReserveImpact(
  reserve: TrustlineReservePreview,
  conversion: Conversion,
  addsTrustline: boolean,
): TrustlineReserveImpact {
  const networkFee = BigInt(BASE_FEE) * BigInt(addsTrustline ? 2 : 1);
  const sourceSpend = conversion.source.id === XLM.id ? conversion.sourceMax : 0n;
  const reservedForTrustline = addsTrustline ? reserve.trustlineReserve : 0n;
  const projectedSpendable =
    reserve.nativeBalance -
    reserve.sellingLiabilities -
    reserve.currentMinimumBalance -
    reservedForTrustline -
    networkFee -
    sourceSpend;
  return { ...reserve, addsTrustline, networkFee, sourceSpend, projectedSpendable };
}
function records(body: Record<string, unknown>): Record<string, unknown>[] {
  const embedded = body._embedded as { records?: unknown } | undefined;
  if (!Array.isArray(embedded?.records)) throw new Error("Invalid Stellar asset list.");
  return embedded.records.filter(
    (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object",
  );
}

export async function accountAssets(account: string, signal?: AbortSignal): Promise<SourceAsset[]> {
  if (!StrKey.isValidEd25519PublicKey(account)) throw new Error("Invalid Stellar account.");
  const body = await horizon(`/accounts/${account}`, signal);
  if (!Array.isArray(body.balances)) throw new Error("Invalid Stellar account balances.");
  let nativeMinimumReserve: bigint | null = null;
  const counts = [body.subentry_count, body.num_sponsoring, body.num_sponsored];
  if (
    counts.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  ) {
    const ledger = records(await horizon("/ledgers?order=desc&limit=1", signal))[0];
    const base = ledger?.base_reserve_in_stroops;
    const entries =
      2 + Number(body.subentry_count) + Number(body.num_sponsoring) - Number(body.num_sponsored);
    if (
      Number.isSafeInteger(entries) &&
      entries >= 0 &&
      ((typeof base === "number" && Number.isSafeInteger(base) && base > 0) ||
        (typeof base === "string" && /^[1-9]\d*$/.test(base)))
    )
      nativeMinimumReserve = BigInt(entries) * BigInt(base);
  }
  return body.balances.flatMap((entry: Record<string, unknown>) => {
    if (typeof entry.balance !== "string") return [];
    if (entry.asset_type === "native") {
      const sellingLiabilities =
        typeof entry.selling_liabilities === "string" ? entry.selling_liabilities : "0.0000000";
      const total = parseUnits(entry.balance, 7);
      const liabilities = parseUnits(sellingLiabilities, 7);
      const afterReserve =
        nativeMinimumReserve === null ? 0n : total - liabilities - nativeMinimumReserve;
      const availableUnits = afterReserve > 0n ? afterReserve : 0n;
      return [
        {
          ...XLM,
          ...(nativeMinimumReserve === null
            ? {}
            : { nativeMinimumReserve: formatSpendableUnits(nativeMinimumReserve) }),
          balance: entry.balance,
          sellingLiabilities,
          available: formatSpendableUnits(availableUnits),
        },
      ];
    }
    if (typeof entry.asset_code !== "string" || typeof entry.asset_issuer !== "string") return [];
    const sellingLiabilities =
      typeof entry.selling_liabilities === "string" ? entry.selling_liabilities : "0.0000000";
    const isFrozen =
      entry.is_authorized === false && entry.is_authorized_to_maintain_liabilities === true;
    const isUnauthorized = entry.is_authorized === false && !isFrozen;
    const trustline: TrustlineState = isFrozen
      ? "frozen"
      : isUnauthorized
        ? "unauthorized"
        : "present";

    const total = parseUnits(entry.balance, 7);
    const liabilities = parseUnits(sellingLiabilities, 7);
    const availableUnits =
      trustline === "frozen" || trustline === "unauthorized"
        ? 0n
        : total > liabilities
          ? total - liabilities
          : 0n;

    const asset: SourceAsset = {
      id: `${entry.asset_code}:${entry.asset_issuer}`,
      code: entry.asset_code,
      issuer: entry.asset_issuer,
      verification: "wallet-trustline",
      trustline,
      balance: entry.balance,
      sellingLiabilities,
      available: formatSpendableUnits(availableUnits),
    };
    stellarAsset(asset);
    return [asset];
  });
}

export async function searchAssets(query: string, signal?: AbortSignal): Promise<SourceAsset[]> {
  const input = query.trim();
  if (!input) return [USDC, XLM];
  if (input.toUpperCase() === "XLM") return [XLM];
  const params = new URLSearchParams({ limit: "40", order: "desc" });
  if (StrKey.isValidEd25519PublicKey(input)) params.set("asset_issuer", input);
  else if (/^[A-Za-z0-9]{1,12}$/.test(input)) params.set("asset_code", input);
  else throw new Error("Search by asset code or full Stellar issuer address.");
  let body: Record<string, unknown>;
  try {
    body = await horizon(`/assets?${params}`, signal);
  } catch (cause) {
    if (signal?.aborted) throw cause;
    const cached = cachedPublicAssetMetadata(input);
    if (!cached.length) throw cause;
    return cached.map((metadata) => ({
      id: `${metadata.code}:${metadata.issuer}`,
      code: metadata.code,
      issuer: metadata.issuer,
      verification: "cached-metadata",
      trustline: "not-checked",
      metadata,
    }));
  }
  return records(body)
    .slice(0, 40)
    .flatMap((entry) => {
      if (typeof entry.asset_code !== "string" || typeof entry.asset_issuer !== "string") return [];
      const asset: SourceAsset = {
        id: `${entry.asset_code}:${entry.asset_issuer}`,
        code: entry.asset_code,
        issuer: entry.asset_issuer,
        verification: "horizon-search",
        trustline: "not-checked",
        metadata: getPublicAssetMetadata(entry.asset_code, entry.asset_issuer),
      };
      stellarAsset(asset);
      return [asset];
    });
}

export interface Conversion {
  source: SourceAsset;
  sourceMax: bigint;
  usdcAmount: bigint;
  path: SourceAsset[];
}
export interface ConversionExecutionIntent {
  operation: "pathPaymentStrictReceive";
  source: SourceAsset;
  sourceMax: bigint;
  destination: SourceAsset;
  destinationAmount: bigint;
  path: SourceAsset[];
  addTrustline: boolean;
}

export function conversionRoute(conversion: Conversion): SourceAsset[] {
  return [conversion.source, ...conversion.path, USDC];
}

export function conversionExecutionIntent(
  conversion: Conversion,
  addTrustline: boolean,
): ConversionExecutionIntent {
  if (conversion.sourceMax <= 0n || conversion.usdcAmount <= 0n || conversion.path.length > 5)
    throw new Error("Invalid conversion quote.");
  stellarAsset(conversion.source);
  conversion.path.forEach(stellarAsset);
  stellarAsset(USDC);
  return {
    operation: "pathPaymentStrictReceive",
    source: conversion.source,
    sourceMax: conversion.sourceMax,
    destination: USDC,
    destinationAmount: conversion.usdcAmount,
    path: conversion.path,
    addTrustline,
  };
}
export interface TradeQuote {
  source: SourceAsset;
  sourceAmount: bigint;
  bridge: LiveQuote;
  conversion: Conversion | null;
}

export async function quoteConversion(source: SourceAsset, amount: bigint): Promise<Conversion> {
  const asset = stellarAsset(source);
  if (source.trustline === "frozen")
    throw new Error(`Trustline for ${source.code} is frozen by the issuer.`);
  if (source.trustline === "unauthorized")
    throw new Error(`Trustline for ${source.code} is not authorized by the issuer.`);
  if (amount <= 0n || amount > (1n << 63n) - 1n)
    throw new Error("Enter a positive amount within Stellar's asset limit.");
  const params = new URLSearchParams({
    source_asset_type: asset.getAssetType(),
    source_amount: formatUnits(amount, 7),
    destination_assets: USDC.id,
  });
  if (!asset.isNative()) {
    params.set("source_asset_code", asset.getCode());
    const issuer = source.issuer;
    if (!issuer) throw new Error("The source asset issuer is missing.");
    params.set("source_asset_issuer", issuer);
  }
  const paths = records(await horizon(`/paths/strict-send?${params}`))
    .flatMap((entry) => {
      if (
        entry.destination_asset_code !== USDC.code ||
        entry.destination_asset_issuer !== USDC.issuer ||
        typeof entry.destination_amount !== "string" ||
        !Array.isArray(entry.path) ||
        entry.path.length > 5
      )
        return [];
      const path: SourceAsset[] = entry.path.map((item: Record<string, unknown>) => {
        if (item.asset_type === "native") return XLM;
        if (typeof item.asset_code !== "string" || typeof item.asset_issuer !== "string")
          throw new Error("Invalid Stellar path asset.");
        const token: SourceAsset = {
          id: `${item.asset_code}:${item.asset_issuer}`,
          code: item.asset_code,
          issuer: item.asset_issuer,
          verification: "horizon-path",
          trustline: "not-checked",
        };
        stellarAsset(token);
        return token;
      });
      return [{ amount: parseUnits(entry.destination_amount, 7), path }];
    })
    .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));
  const best = paths[0];
  if (!best)
    throw new Error(`No liquid ${source.code} to USDC path is available on Stellar Testnet.`);
  const usdcAmount = (best.amount * (10000n - SLIPPAGE_BPS)) / 10000n;
  if (usdcAmount <= 0n) throw new Error("This amount is too small to convert.");
  return { source, sourceMax: amount, usdcAmount, path: best.path };
}

export async function revalidateConversion(reviewed: Conversion): Promise<Conversion> {
  const current = await quoteConversion(reviewed.source, reviewed.sourceMax);
  if (current.usdcAmount < reviewed.usdcAmount)
    throw new Error(
      "The Stellar conversion path no longer meets the reviewed USDC minimum. Refresh the quote before signing.",
    );
  if (
    current.path.length !== reviewed.path.length ||
    current.path.some((asset, index) => {
      const original = reviewed.path[index];
      return asset.code !== original?.code || asset.issuer !== original.issuer;
    })
  )
    throw new Error("The conversion path changed. Review the updated path before signing.");
  return reviewed;
}

export async function quoteTrade(
  destination: DestinationKey,
  source: SourceAsset,
  input: string,
  route: BridgeRoute,
): Promise<TradeQuote> {
  stellarAsset(source);
  if (source.trustline === "frozen")
    throw new Error(`Trustline for ${source.code} is frozen by the issuer.`);
  if (source.trustline === "unauthorized")
    throw new Error(`Trustline for ${source.code} is not authorized by the issuer.`);
  const amount = parseUnits(input.trim(), 7);
  if (amount <= 0n || amount > (1n << 63n) - 1n)
    throw new Error("Enter a positive amount within Stellar's asset limit.");
  const conversion = source.id === USDC.id ? null : await quoteConversion(source, amount);
  const bridge = await quoteTransfer(destination, conversion?.usdcAmount ?? amount, route);
  return { source, sourceAmount: amount, bridge, conversion };
}

export function conversionOperations(
  sender: string,
  conversion: Conversion,
  addTrustline: boolean,
): xdr.Operation[] {
  const intent = conversionExecutionIntent(conversion, addTrustline);
  const operations: xdr.Operation[] = [];
  if (intent.addTrustline) operations.push(Operation.changeTrust({ asset: stellarAsset(USDC) }));
  operations.push(
    Operation.pathPaymentStrictReceive({
      sendAsset: stellarAsset(intent.source),
      sendMax: formatUnits(intent.sourceMax, 7),
      destination: sender,
      destAsset: stellarAsset(intent.destination),
      destAmount: formatUnits(intent.destinationAmount, 7),
      path: intent.path.map(stellarAsset),
    }),
  );
  return operations;
}

export async function submitConversion(
  sender: string,
  conversion: Conversion,
  sign: WalletSigner,
  progress?: (phase: TransactionPhase, hash?: string) => void,
  approval?: WalletApprovalProvenance,
  reconcile?: SubmissionReconciliation,
  signal?: AbortSignal,
): Promise<TransactionResult> {
  const assets = await accountAssets(sender);
  const sourceAsset = assets.find((asset) => asset.id === conversion.source.id);
  if (!sourceAsset)
    throw new Error(`Trustline for ${conversion.source.code} not found on your account.`);
  if (sourceAsset.trustline === "frozen")
    throw new Error(`Trustline for ${conversion.source.code} is frozen by the issuer.`);
  if (sourceAsset.trustline === "unauthorized")
    throw new Error(`Trustline for ${conversion.source.code} is not authorized by the issuer.`);
  const spendable = parseUnits(spendableBalance(sourceAsset), 7);
  if (spendable < conversion.sourceMax)
    throw new Error(
      sourceAsset.sellingLiabilities && parseUnits(sourceAsset.sellingLiabilities, 7) > 0n
        ? `Insufficient available ${conversion.source.code} balance. Selling liabilities reduce your spendable balance to ${spendableBalance(sourceAsset)} ${conversion.source.code}.`
        : `Insufficient ${conversion.source.code} balance.`,
    );
  const addTrustline = !assets.some((asset) => asset.id === USDC.id);
  // Re-read the reserve right before building the transaction (never trust UI-cached state) and
  // refuse to ask the wallet to sign when the combined trustline-plus-conversion would leave the
  // account below its minimum balance. This is the one place every caller of submitConversion
  // passes through, so it holds even if a stale quote slipped past the review screen's own check.
  const reserve = await accountTrustlineReserve(sender);
  const impact = trustlineReserveImpact(reserve, conversion, addTrustline);
  if (impact.projectedSpendable < 0n)
    throw new Error(
      addTrustline
        ? `Adding the USDC trustline locks ${formatUnits(reserve.trustlineReserve, 7)} XLM in reserve. Your balance cannot cover that reserve, the network fee and this conversion.`
        : "Your XLM balance cannot cover this conversion and its network fee.",
    );
  return submitClassicOperations(
    sender,
    async () => {
      const current = await revalidateConversion(conversion);
      return conversionOperations(sender, current, addTrustline);
    },
    sign,
    progress,
    approval,
    reconcile,
    signal,
  );
}

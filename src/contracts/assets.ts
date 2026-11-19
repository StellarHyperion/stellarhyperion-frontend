import { Asset, BASE_FEE, Operation, StrKey, type xdr } from "@stellar/stellar-sdk";
import { formatUnits, parseUnits } from "@hyperion/protocol";
import type { SourceAsset as _Unused } from "./assets";
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

export function isCanonicalUsdc(asset: SourceAsset): boolean {
  return asset.id === USDC.id && asset.code === USDC.code && asset.issuer === USDC.issuer;
}

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

export async function requireRecoveredUsdc(
  account: string,
  amount: bigint,
  signal?: AbortSignal,
): Promise<void> {
  const assets = await accountAssets(account, signal);
  const usdc = assets.find((asset) => asset.id === USDC.id);
  if (
    amount <= 0n ||
    usdc?.trustline !== "present" ||
    usdc.available === undefined ||
    parseUnits(usdc.available, 7) < amount
  )
    throw new Error("The confirmed conversion's USDC is not currently available in this wallet.");
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
  pathComparison: ConversionPathComparison;
}
export interface ConversionPathComparison {
  returnedPaths: number;
  eligiblePaths: number;
  selectedOutput: bigint;
  excludedPaths: number;
  diagnostics: ConversionPathDiagnostic[];
  omittedDiagnostics: number;
}
export interface ConversionPathDiagnostic {
  responseIndex: number | null;
  reason: string;
}
interface ConversionPathCandidate {
  output: bigint;
  path: SourceAsset[];
  key: string;
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

export const MAX_CONVERSION_PATHS = 50;
const MAX_PATH_DIAGNOSTICS = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactPathAmount(value: unknown, label: string): { amount?: bigint; reason?: string } {
  if (typeof value !== "string") return { reason: `${label} is missing or not a string.` };
  if (value.length > 27 || !/^\d{1,19}(?:\.\d{1,7})?$/.test(value))
    return { reason: `${label} is not a valid exact 7-decimal amount.` };
  let amount: bigint;
  try {
    amount = parseUnits(value, 7);
  } catch {
    return { reason: `${label} is not a valid exact 7-decimal amount.` };
  }
  if (amount <= 0n) return { reason: `${label} must be positive.` };
  return { amount };
}

function parseConversionPathCandidate(
  entry: unknown,
  source: SourceAsset,
  sourceAsset: Asset,
  sourceAmount: bigint,
  destinationAsset: Asset,
): { candidate?: ConversionPathCandidate; reason?: string } {
  if (!isRecord(entry)) return { reason: "record is not an object." };
  if (entry.source_asset_type !== sourceAsset.getAssetType())
    return { reason: "source asset type does not match the requested asset." };
  if (
    !sourceAsset.isNative() &&
    (entry.source_asset_code !== source.code || entry.source_asset_issuer !== source.issuer)
  )
    return { reason: "source code or issuer does not match the requested asset." };
  if (
    sourceAsset.isNative() &&
    ((entry.source_asset_code !== undefined && entry.source_asset_code !== null) ||
      (entry.source_asset_issuer !== undefined && entry.source_asset_issuer !== null))
  )
    return { reason: "native source includes issued-asset identity fields." };
  const returnedSourceAmount = exactPathAmount(entry.source_amount, "source amount");
  if (returnedSourceAmount.reason) return { reason: returnedSourceAmount.reason };
  if (returnedSourceAmount.amount !== sourceAmount)
    return { reason: "source amount does not match the requested spend cap." };
  if (
    entry.destination_asset_type !== destinationAsset.getAssetType() ||
    entry.destination_asset_code !== USDC.code ||
    entry.destination_asset_issuer !== USDC.issuer
  )
    return { reason: "destination asset is not canonical USDC." };
  const output = exactPathAmount(entry.destination_amount, "destination amount");
  if (output.reason) return { reason: output.reason };
  if (output.amount === undefined) return { reason: "destination amount is invalid." };
  if (output.amount > (1n << 63n) - 1n)
    return { reason: "destination amount exceeds Stellar's asset limit." };
  if (!Array.isArray(entry.path)) return { reason: "path is not an array." };
  if (entry.path.length > 5) return { reason: "path exceeds Stellar's five-asset limit." };

  const visited = new Set([source.id, USDC.id]);
  const path: SourceAsset[] = [];
  for (const [index, item] of entry.path.entries()) {
    if (!isRecord(item)) return { reason: `path asset ${index + 1} is not an object.` };
    if (item.asset_type === "native") {
      if (
        (item.asset_code !== undefined && item.asset_code !== null) ||
        (item.asset_issuer !== undefined && item.asset_issuer !== null)
      )
        return {
          reason: `path asset ${index + 1} includes issued-asset identity fields on a native asset.`,
        };
      if (visited.has(XLM.id)) return { reason: `path asset ${index + 1} repeats an asset.` };
      visited.add(XLM.id);
      path.push(XLM);
      continue;
    }
    if (item.asset_type !== "credit_alphanum4" && item.asset_type !== "credit_alphanum12")
      return { reason: `path asset ${index + 1} has an unsupported asset type.` };
    if (typeof item.asset_code !== "string" || typeof item.asset_issuer !== "string")
      return { reason: `path asset ${index + 1} is missing its code or issuer.` };
    const token: SourceAsset = {
      id: `${item.asset_code}:${item.asset_issuer}`,
      code: item.asset_code,
      issuer: item.asset_issuer,
      verification: "horizon-path",
      trustline: "not-checked",
    };
    let tokenAsset: Asset;
    try {
      tokenAsset = stellarAsset(token);
    } catch {
      return { reason: `path asset ${index + 1} has an invalid code or issuer.` };
    }
    if (tokenAsset.getAssetType() !== item.asset_type)
      return { reason: `path asset ${index + 1} type does not match its code.` };
    if (visited.has(token.id)) return { reason: `path asset ${index + 1} repeats an asset.` };
    visited.add(token.id);
    path.push(token);
  }
  const key = path.map((asset) => asset.id).join("\u0000");
  return { candidate: { output: output.amount, path, key } };
}

export function compareConversionPaths(
  source: SourceAsset,
  sourceAmount: bigint,
  entries: unknown[],
): {
  selected: { output: bigint; path: SourceAsset[] } | null;
  returnedPaths: number;
  eligiblePaths: number;
  excludedPaths: number;
  diagnostics: ConversionPathDiagnostic[];
  omittedDiagnostics: number;
} {
  if (entries.length > MAX_CONVERSION_PATHS) {
    return {
      selected: null,
      returnedPaths: entries.length,
      eligiblePaths: 0,
      excludedPaths: entries.length,
      diagnostics: [
        {
          responseIndex: null,
          reason: `Horizon returned more than the ${MAX_CONVERSION_PATHS}-path comparison limit; all paths were excluded.`,
        },
      ],
      omittedDiagnostics: 0,
    };
  }
  const sourceAsset = stellarAsset(source);
  const destinationAsset = stellarAsset(USDC);
  const candidates: ConversionPathCandidate[] = [];
  const diagnostics: ConversionPathDiagnostic[] = [];
  let excludedPaths = 0;
  entries.forEach((entry, responseIndex) => {
    const result = parseConversionPathCandidate(
      entry,
      source,
      sourceAsset,
      sourceAmount,
      destinationAsset,
    );
    if (result.candidate) {
      candidates.push(result.candidate);
    } else {
      excludedPaths += 1;
      if (diagnostics.length < MAX_PATH_DIAGNOSTICS)
        diagnostics.push({ responseIndex, reason: result.reason ?? "path is invalid." });
    }
  });
  candidates.sort((left, right) => {
    if (left.output !== right.output) return left.output > right.output ? -1 : 1;
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });
  const best = candidates[0];
  return {
    selected: best ? { output: best.output, path: best.path } : null,
    returnedPaths: entries.length,
    eligiblePaths: candidates.length,
    excludedPaths,
    diagnostics,
    omittedDiagnostics: excludedPaths - diagnostics.length,
  };
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
    limit: String(MAX_CONVERSION_PATHS),
  });
  if (!asset.isNative()) {
    params.set("source_asset_code", asset.getCode());
    const issuer = source.issuer;
    if (!issuer) throw new Error("The source asset issuer is missing.");
    params.set("source_asset_issuer", issuer);
  }
  const body = await horizon(`/paths/strict-send?${params}`);
  const embedded = body._embedded as { records?: unknown } | undefined;
  if (!Array.isArray(embedded?.records)) throw new Error("Invalid Stellar path list.");
  const comparison = compareConversionPaths(source, amount, embedded.records);
  const best = comparison.selected;
  if (!best) {
    const diagnostics = comparison.diagnostics
      .map(({ responseIndex, reason }) =>
        responseIndex === null ? reason : `Path ${responseIndex + 1}: ${reason}`,
      )
      .join(" ");
    const omitted =
      comparison.omittedDiagnostics > 0
        ? ` ${comparison.omittedDiagnostics} additional path exclusions are omitted.`
        : "";
    throw new Error(
      `No liquid ${source.code} to USDC path is available on Stellar Testnet. ${diagnostics}${omitted}`.trim(),
    );
  }
  const usdcAmount = (best.output * (10000n - SLIPPAGE_BPS)) / 10000n;
  if (usdcAmount <= 0n) throw new Error("This amount is too small to convert.");
  return {
    source,
    sourceMax: amount,
    usdcAmount,
    path: best.path,
    pathComparison: {
      returnedPaths: comparison.returnedPaths,
      eligiblePaths: comparison.eligiblePaths,
      selectedOutput: best.output,
      excludedPaths: comparison.excludedPaths,
      diagnostics: comparison.diagnostics,
      omittedDiagnostics: comparison.omittedDiagnostics,
    },
  };
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
  const conversion = isCanonicalUsdc(source) ? null : await quoteConversion(source, amount);
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

import { Asset, Operation, StrKey, type xdr } from "@stellar/stellar-sdk";
import { formatUnits, parseUnits } from "@hyperion/protocol";
import { TESTNET, type BridgeRoute, type DestinationKey } from "../config/testnet";
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
  /**
   * Spendable balance: balance minus selling liabilities, and, for native XLM, also minus the
   * account's live minimum reserve (base reserve times its actual subentry/sponsorship count
   * from Horizon) and a margin for the transaction fees a conversion can incur. Exact stroop
   * integer arithmetic, formatted to 7 decimals.
   */
  available?: string;
  /** Native XLM only: the account's live minimum reserve. Absent when it could not be confirmed. */
  nativeMinimumReserve?: string;
}
export type AssetVerification =
  "configured" | "wallet-trustline" | "horizon-search" | "horizon-path";
export type TrustlineState = "native" | "present" | "not-checked" | "frozen" | "unauthorized";

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
const RESERVE_UNAVAILABLE = "Stellar reserve and fee parameters could not be confirmed.";
/**
 * Conversion builds up to two operations (an optional `changeTrust` plus the path payment, see
 * `conversionOperations`). The spendable figure reserves this many base fees against that.
 */
const XLM_FEE_MARGIN_OPERATIONS = 2n;

export function issuerVerificationLabel(asset: SourceAsset): string {
  if (!asset.issuer) return "Native Stellar asset; no issuer";
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
function records(body: Record<string, unknown>): Record<string, unknown>[] {
  const embedded = body._embedded as { records?: unknown } | undefined;
  if (!Array.isArray(embedded?.records)) throw new Error("Invalid Stellar asset list.");
  return embedded.records.filter(
    (entry): entry is Record<string, unknown> => !!entry && typeof entry === "object",
  );
}

interface LedgerReserveParams {
  baseFee: bigint;
  baseReserve: bigint;
}
/** The network's current base fee and base reserve, read live from the latest ledger. */
async function ledgerReserveParams(signal?: AbortSignal): Promise<LedgerReserveParams> {
  const [ledger] = records(await horizon("/ledgers?order=desc&limit=1", signal));
  const baseFee = ledger?.base_fee_in_stroops;
  const baseReserve = ledger?.base_reserve_in_stroops;
  if (
    typeof baseFee !== "number" ||
    typeof baseReserve !== "number" ||
    !Number.isInteger(baseFee) ||
    !Number.isInteger(baseReserve) ||
    baseFee <= 0 ||
    baseReserve <= 0
  )
    throw new Error(RESERVE_UNAVAILABLE);
  return { baseFee: BigInt(baseFee), baseReserve: BigInt(baseReserve) };
}

/**
 * The account's minimum XLM balance: the base reserve times (2 + subentries + sponsoring -
 * sponsored), per Horizon's account fields. This already scales with however many trustlines,
 * offers or sponsorships the account actually holds.
 */
export function minimumXlmReserve(
  subentryCount: number,
  numSponsoring: number,
  numSponsored: number,
  baseReserve: bigint,
): bigint {
  const entries = 2 + subentryCount + numSponsoring - numSponsored;
  if (!Number.isInteger(entries) || entries < 2)
    throw new Error("Invalid Stellar reserve accounting.");
  return BigInt(entries) * baseReserve;
}

/** Conservative spendable XLM: balance minus selling liabilities, the reserve and a fee margin. */
export function spendableXlm(
  balance: bigint,
  sellingLiabilities: bigint,
  reserve: bigint,
  feeMargin: bigint,
): bigint {
  const spendable = balance - sellingLiabilities - reserve - feeMargin;
  return spendable > 0n ? spendable : 0n;
}

/**
 * Whether `native`'s spendable XLM (`available`, already net of its own live reserve) covers an
 * additional `required` stroops, such as a bridge's relay gas budget. Returns `"unknown"` rather
 * than assuming safety when the live reserve could not be confirmed from Horizon.
 */
export function xlmShortfall(
  native: SourceAsset | undefined,
  required: bigint,
): "ok" | "insufficient" | "unknown" {
  if (required <= 0n) return "ok";
  if (native?.nativeMinimumReserve === undefined) return "unknown";
  return parseUnits(native.available ?? "0.0000000", 7) >= required ? "ok" : "insufficient";
}

export async function accountAssets(account: string, signal?: AbortSignal): Promise<SourceAsset[]> {
  if (!StrKey.isValidEd25519PublicKey(account)) throw new Error("Invalid Stellar account.");
  const body = await horizon(`/accounts/${account}`, signal);
  if (!Array.isArray(body.balances)) throw new Error("Invalid Stellar account balances.");
  const subentryCount =
    typeof body.subentry_count === "number" &&
    Number.isSafeInteger(body.subentry_count) &&
    body.subentry_count >= 0
      ? body.subentry_count
      : null;
  const numSponsoring =
    typeof body.num_sponsoring === "number" &&
    Number.isSafeInteger(body.num_sponsoring) &&
    body.num_sponsoring >= 0
      ? body.num_sponsoring
      : 0;
  const numSponsored =
    typeof body.num_sponsored === "number" &&
    Number.isSafeInteger(body.num_sponsored) &&
    body.num_sponsored >= 0
      ? body.num_sponsored
      : 0;
  const reserve =
    subentryCount === null
      ? null
      : await ledgerReserveParams(signal)
          .then((params) => ({ params, subentryCount, numSponsoring, numSponsored }))
          .catch(() => null);
  return body.balances.flatMap((entry: Record<string, unknown>): SourceAsset[] => {
    if (typeof entry.balance !== "string") return [];
    if (entry.asset_type === "native") {
      const sellingLiabilities =
        typeof entry.selling_liabilities === "string" ? entry.selling_liabilities : "0.0000000";
      if (!reserve)
        return [{ ...XLM, balance: entry.balance, sellingLiabilities, available: "0.0000000" }];
      const balance = parseUnits(entry.balance, 7);
      const liabilities = parseUnits(sellingLiabilities, 7);
      const minReserve = minimumXlmReserve(
        reserve.subentryCount,
        reserve.numSponsoring,
        reserve.numSponsored,
        reserve.params.baseReserve,
      );
      const feeMargin = XLM_FEE_MARGIN_OPERATIONS * reserve.params.baseFee;
      const availableUnits = spendableXlm(balance, liabilities, minReserve, feeMargin);
      return [
        {
          ...XLM,
          balance: entry.balance,
          sellingLiabilities,
          nativeMinimumReserve: formatSpendableUnits(minReserve),
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
  const body = await horizon(`/assets?${params}`, signal);
  return records(body).flatMap((entry) => {
    if (typeof entry.asset_code !== "string" || typeof entry.asset_issuer !== "string") return [];
    const asset: SourceAsset = {
      id: `${entry.asset_code}:${entry.asset_issuer}`,
      code: entry.asset_code,
      issuer: entry.asset_issuer,
      verification: "horizon-search",
      trustline: "not-checked",
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
  return submitClassicOperations(
    sender,
    async () => {
      const current = await revalidateConversion(conversion);
      return conversionOperations(sender, current, !assets.some((asset) => asset.id === USDC.id));
    },
    sign,
    progress,
    approval,
    reconcile,
    signal,
  );
}

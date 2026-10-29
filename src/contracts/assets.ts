import { Asset, Operation, StrKey, type xdr } from "@stellar/stellar-sdk";
import { formatUnits, parseUnits } from "@hyperion/protocol";
import { TESTNET, type BridgeRoute, type DestinationKey } from "../config/testnet";
import {
  quoteTransfer,
  submitClassicOperations,
  type LiveQuote,
  type TransactionPhase,
  type TransactionResult,
  type WalletSigner,
} from "./stellar";

export interface SourceAsset {
  id: string;
  code: string;
  issuer: string | null;
  balance?: string;
}
export const XLM: SourceAsset = { id: "native", code: "XLM", issuer: null };
export const USDC: SourceAsset = {
  id: `${TESTNET.usdcCode}:${TESTNET.usdcIssuer}`,
  code: TESTNET.usdcCode,
  issuer: TESTNET.usdcIssuer,
};
export const SLIPPAGE_BPS = 50n;

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

export async function accountAssets(account: string, signal?: AbortSignal): Promise<SourceAsset[]> {
  if (!StrKey.isValidEd25519PublicKey(account)) throw new Error("Invalid Stellar account.");
  const body = await horizon(`/accounts/${account}`, signal);
  if (!Array.isArray(body.balances)) throw new Error("Invalid Stellar account balances.");
  return body.balances.flatMap((entry: Record<string, unknown>) => {
    if (typeof entry.balance !== "string") return [];
    if (entry.asset_type === "native") return [{ ...XLM, balance: entry.balance }];
    if (
      entry.is_authorized === false ||
      typeof entry.asset_code !== "string" ||
      typeof entry.asset_issuer !== "string"
    )
      return [];
    const asset = {
      id: `${entry.asset_code}:${entry.asset_issuer}`,
      code: entry.asset_code,
      issuer: entry.asset_issuer,
      balance: entry.balance,
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
    const asset = {
      id: `${entry.asset_code}:${entry.asset_issuer}`,
      code: entry.asset_code,
      issuer: entry.asset_issuer,
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
export interface TradeQuote {
  source: SourceAsset;
  sourceAmount: bigint;
  bridge: LiveQuote;
  conversion: Conversion | null;
}

export async function quoteConversion(source: SourceAsset, amount: bigint): Promise<Conversion> {
  const asset = stellarAsset(source);
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
        const token = {
          id: `${item.asset_code}:${item.asset_issuer}`,
          code: item.asset_code,
          issuer: item.asset_issuer,
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

export async function quoteTrade(
  destination: DestinationKey,
  source: SourceAsset,
  input: string,
  route: BridgeRoute,
): Promise<TradeQuote> {
  stellarAsset(source);
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
  if (conversion.sourceMax <= 0n || conversion.usdcAmount <= 0n || conversion.path.length > 5)
    throw new Error("Invalid conversion quote.");
  const operations: xdr.Operation[] = [];
  if (addTrustline) operations.push(Operation.changeTrust({ asset: stellarAsset(USDC) }));
  operations.push(
    Operation.pathPaymentStrictReceive({
      sendAsset: stellarAsset(conversion.source),
      sendMax: formatUnits(conversion.sourceMax, 7),
      destination: sender,
      destAsset: stellarAsset(USDC),
      destAmount: formatUnits(conversion.usdcAmount, 7),
      path: conversion.path.map(stellarAsset),
    }),
  );
  return operations;
}

export async function submitConversion(
  sender: string,
  conversion: Conversion,
  sign: WalletSigner,
  progress?: (phase: TransactionPhase, hash?: string) => void,
): Promise<TransactionResult> {
  const assets = await accountAssets(sender);
  const balance = assets.find((asset) => asset.id === conversion.source.id)?.balance ?? "0";
  if (parseUnits(balance, 7) < conversion.sourceMax)
    throw new Error(`Insufficient ${conversion.source.code} balance.`);
  return submitClassicOperations(
    sender,
    conversionOperations(sender, conversion, !assets.some((asset) => asset.id === USDC.id)),
    sign,
    progress,
  );
}

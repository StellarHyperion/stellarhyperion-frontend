import { AmbiguousTransactionError, type StellarNetworkName } from "./types";

/**
 * Independently supported Stellar testnet lanes.
 * Exposes only independently verified testnet infrastructure.
 */
export interface StellarTestnetLane {
  readonly id: string;
  readonly name: StellarNetworkName;
  readonly networkPassphrase: string;
  readonly rpcUrl: string;
  readonly isIndependent: boolean;
}

export const INDEPENDENT_TESTNET_LANES: readonly StellarTestnetLane[] = [
  {
    id: "stellar-testnet",
    name: "TESTNET",
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    isIndependent: true,
  },
] as const;

export function getSupportedLanes(): readonly StellarTestnetLane[] {
  return INDEPENDENT_TESTNET_LANES;
}

/**
 * Exact integer amount parser preserving full 7-decimal stroop precision.
 * Avoids lossy floating point representations.
 */
export function toExactIntegerStroops(amount: string | bigint | number, decimals = 7): bigint {
  if (typeof amount === "bigint") {
    return amount;
  }
  const str = String(amount).trim();
  if (!str || !/^\d+(\.\d+)?$/.test(str)) {
    throw new Error(`Invalid numeric amount "${str}" for exact stroop conversion.`);
  }

  const [whole, fraction = ""] = str.split(".");
  if (fraction.length > decimals) {
    throw new Error(
      `Amount "${str}" exceeds maximum allowed precision of ${decimals} decimal places.`,
    );
  }

  const paddedFraction = fraction.padEnd(decimals, "0");
  const combined = `${whole}${paddedFraction}`.replace(/^0+(?=\d)/, "") || "0";
  return BigInt(combined);
}

/**
 * Format exact integer stroops back to string without floating point conversion.
 */
export function fromExactIntegerStroops(stroops: bigint, decimals = 7): string {
  const isNegative = stroops < 0n;
  const abs = isNegative ? -stroops : stroops;
  const raw = abs.toString().padStart(decimals + 1, "0");
  const whole = raw.slice(0, raw.length - decimals);
  const frac = raw.slice(raw.length - decimals);
  const res = `${whole}.${frac}`;
  return isNegative ? `-${res}` : res;
}

/**
 * Issuer-specific token identity.
 * Stellar assets with identical codes from different issuers are treated as distinct.
 */
export interface StellarTokenIdentifier {
  readonly code: string;
  readonly issuer?: string;
  readonly contractId?: string;
}

export function createTokenIdentifier(
  code: string,
  issuerOrContract?: string,
): StellarTokenIdentifier {
  const cleanCode = code.trim().toUpperCase();
  if (!issuerOrContract) {
    return { code: cleanCode };
  }
  if (issuerOrContract.startsWith("C") && issuerOrContract.length === 56) {
    return { code: cleanCode, contractId: issuerOrContract };
  }
  return { code: cleanCode, issuer: issuerOrContract };
}

export function areTokenIdentitiesEqual(
  a: StellarTokenIdentifier,
  b: StellarTokenIdentifier,
): boolean {
  if (a.code.toUpperCase() !== b.code.toUpperCase()) {
    return false;
  }
  if (a.issuer || b.issuer) {
    return a.issuer === b.issuer;
  }
  if (a.contractId || b.contractId) {
    return a.contractId === b.contractId;
  }
  return true;
}

export function formatTokenIdentifier(token: StellarTokenIdentifier): string {
  if (token.contractId) {
    return `${token.code}:${token.contractId}`;
  }
  if (token.issuer) {
    return `${token.code}:${token.issuer}`;
  }
  return `${token.code}:native`;
}

/**
 * Execution tracking separating source ledger confirmation from destination delivery.
 */
export type SourceConfirmationStatus =
  | "unsubmitted"
  | "signing"
  | "signed"
  | "submitted"
  | "source_confirmed"
  | "failed"
  | "ambiguous";

export type DestinationDeliveryStatus =
  | "idle"
  | "in_transit"
  | "relayed"
  | "delivered"
  | "failed";

export interface StageTrackingResult {
  readonly isSourceConfirmed: boolean;
  readonly isDestinationDelivered: boolean;
  readonly summary: string;
}

export function evaluateStageTracking(
  sourceStatus: SourceConfirmationStatus,
  destinationStatus: DestinationDeliveryStatus,
): StageTrackingResult {
  const isSourceConfirmed = sourceStatus === "source_confirmed";
  const isDestinationDelivered = destinationStatus === "delivered";

  let summary = "idle";
  if (sourceStatus === "ambiguous") {
    summary = "source state ambiguous; ledger verification required";
  } else if (!isSourceConfirmed && sourceStatus === "submitted") {
    summary = "awaiting stellar ledger close";
  } else if (isSourceConfirmed && !isDestinationDelivered) {
    summary = "stellar confirmed; awaiting destination delivery";
  } else if (isSourceConfirmed && isDestinationDelivered) {
    summary = "transfer settled on destination";
  } else if (sourceStatus === "failed" || destinationStatus === "failed") {
    summary = "transfer execution failed";
  }

  return {
    isSourceConfirmed,
    isDestinationDelivered,
    summary,
  };
}

/**
 * Determine if an error is ambiguous regarding whether the transaction executed on-chain.
 */
export function isAmbiguousNetworkError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("504") ||
    msg.includes("gateway") ||
    msg.includes("econnreset") ||
    msg.includes("ambiguous") ||
    msg.includes("network error") ||
    msg.includes("undetermined")
  );
}

/**
 * Enforce that ambiguous signed transactions are never automatically resubmitted.
 */
export function assertNoAutomaticResubmission(
  status: SourceConfirmationStatus,
  txHash?: string,
): void {
  if (status === "ambiguous" || status === "signed") {
    throw new AmbiguousTransactionError(
      "Ambiguous signed transaction must never be automatically resubmitted without explicit user approval.",
      txHash,
    );
  }
}

/**
 * Validate returned signature result.
 */
export function validateSignatureResult(result: {
  signedTxXdr?: string;
  signedAuthEntry?: string;
}): { valid: boolean; error?: string } {
  if (!result || typeof result !== "object") {
    return { valid: false, error: "Empty signature response from wallet." };
  }
  if (!result.signedTxXdr && !result.signedAuthEntry) {
    return { valid: false, error: "Wallet returned neither signedTxXdr nor signedAuthEntry." };
  }
  const payload = result.signedTxXdr ?? result.signedAuthEntry ?? "";
  if (payload.trim().length === 0) {
    return { valid: false, error: "Wallet signature payload is empty string." };
  }
  return { valid: true };
}

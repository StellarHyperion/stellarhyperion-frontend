import { formatUnits, parseUnits } from "@hyperion/protocol";

/**
 * Format, exact-amount parsing, conservation checks, and explorer deep link helpers for Hyperion.
 *
 * Resolves chain-specific block explorer deep links for transactions and accounts
 * across Stellar and supported EVM networks, and enforces lossless integer amount rendering.
 */

export const MAX_TOKEN_DECIMALS = 38;
export const STELLAR_CLASSIC_MAX = (1n << 63n) - 1n;
export const SOROBAN_I128_MAX = (1n << 127n) - 1n;

export interface QuoteConservationInput {
  route: 0 | 1;
  grossAmount: bigint;
  fee: bigint;
  netAmount: bigint;
  destinationAmount: bigint;
  relayGas: bigint;
}

export interface QuoteConservationReport {
  valid: boolean;
  reason: string | null;
  destinationDecimals: 6 | 7;
  subUnitRemainderStroops: bigint;
  formatted: {
    grossAmount: string;
    fee: string;
    netAmount: string;
    relayGas: string;
    destinationAmount: string;
  };
}

export function isSupportedDecimals(decimals: number): boolean {
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= MAX_TOKEN_DECIMALS;
}

export function shortenAddress(addr: string): string {
  if (!addr) return "";
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-6)}`;
}

export function shortenTxHash(hash: string): string {
  if (!hash) return "";
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 10)}...${hash.slice(-8)}`;
}

/**
 * Returns the block explorer deep link for a transaction hash or account address
 * given the specific network chain key.
 */
export function getExplorerUrl(chainKey: string, type: "tx" | "address", id: string): string {
  const cleanId = encodeURIComponent(id.trim());
  const normalizedKey = chainKey.trim().toLowerCase();

  switch (normalizedKey) {
    case "stellar-testnet": {
      if (type === "tx") {
        return `https://stellar.expert/explorer/testnet/tx/${cleanId}`;
      }
      const isContract = id.trim().startsWith("C");
      const pathSegment = isContract ? "contract" : "account";
      return `https://stellar.expert/explorer/testnet/${pathSegment}/${cleanId}`;
    }

    case "stellar":
    case "stellar-public": {
      if (type === "tx") {
        return `https://stellar.expert/explorer/public/tx/${cleanId}`;
      }
      const isContract = id.trim().startsWith("C");
      const pathSegment = isContract ? "contract" : "account";
      return `https://stellar.expert/explorer/public/${pathSegment}/${cleanId}`;
    }

    case "sepolia":
    case "ethereum-sepolia": {
      const segment = type === "tx" ? "tx" : "address";
      return `https://sepolia.etherscan.io/${segment}/${cleanId}`;
    }

    case "base-sepolia": {
      const segment = type === "tx" ? "tx" : "address";
      return `https://sepolia.basescan.org/${segment}/${cleanId}`;
    }

    case "arbitrum-sepolia": {
      const segment = type === "tx" ? "tx" : "address";
      return `https://sepolia.arbiscan.io/${segment}/${cleanId}`;
    }

    case "arc-testnet": {
      const segment = type === "tx" ? "tx" : "address";
      return `https://explorer.testnet.arc.io/${segment}/${cleanId}`;
    }

    case "ethereum":
    case "mainnet": {
      const segment = type === "tx" ? "tx" : "address";
      return `https://etherscan.io/${segment}/${cleanId}`;
    }

    case "base": {
      const segment = type === "tx" ? "tx" : "address";
      return `https://basescan.org/${segment}/${cleanId}`;
    }

    case "arc": {
      const segment = type === "tx" ? "tx" : "address";
      return `https://explorer.arc.io/${segment}/${cleanId}`;
    }

    default: {
      const segment = type === "tx" ? "tx" : "address";
      return `https://sepolia.etherscan.io/${segment}/${cleanId}`;
    }
  }
}

export function formatExactAmount(amount: bigint, decimals: number): string {
  if (!isSupportedDecimals(decimals)) {
    throw new Error("Unsupported token decimal precision.");
  }
  if (amount < 0n) {
    throw new Error("Token amounts must be non-negative integers.");
  }
  return formatUnits(amount, decimals);
}

export function parseExactAmount(
  value: string,
  decimals: number,
  maxAmount: bigint = SOROBAN_I128_MAX,
): bigint {
  if (!isSupportedDecimals(decimals)) {
    throw new Error("Unsupported token decimal precision.");
  }
  const trimmed = value.trim();
  const parsed = parseUnits(trimmed, decimals);
  if (parsed <= 0n || parsed > maxAmount) {
    throw new Error("Enter a positive token amount within the protocol limit.");
  }
  return parsed;
}

export function formatTokenAmount(value: string, decimals?: number | null): string {
  if (!/^\d+$/.test(value)) return "unavailable";
  const amount = BigInt(value);
  if (decimals === null || decimals === undefined) {
    return `${amount} base units`;
  }
  if (!isSupportedDecimals(decimals)) {
    return "unavailable";
  }
  return formatUnits(amount, decimals);
}

export function verifyQuoteConservation(input: QuoteConservationInput): QuoteConservationReport {
  const destinationDecimals: 6 | 7 = input.route === 0 ? 6 : 7;
  const invalid = (reason: string): QuoteConservationReport => ({
    valid: false,
    reason,
    destinationDecimals,
    subUnitRemainderStroops: 0n,
    formatted: {
      grossAmount: "unavailable",
      fee: "unavailable",
      netAmount: "unavailable",
      relayGas: "unavailable",
      destinationAmount: "unavailable",
    },
  });

  if (
    input.grossAmount <= 0n ||
    input.grossAmount > SOROBAN_I128_MAX ||
    input.fee < 0n ||
    input.netAmount <= 0n ||
    input.relayGas <= 0n ||
    input.relayGas > SOROBAN_I128_MAX ||
    input.destinationAmount <= 0n
  ) {
    return invalid("Quote amounts must be positive integers within Soroban i128 bounds.");
  }

  if (input.grossAmount !== input.fee + input.netAmount) {
    return invalid("Origin gross amount does not equal protocol fee plus net bridged amount.");
  }

  let subUnitRemainderStroops = 0n;
  if (input.route === 0) {
    if (input.relayGas % 10n !== 0n) {
      return invalid("Circle forwarding budget must align to six-decimal USDC precision.");
    }
    if (input.relayGas >= input.netAmount) {
      return invalid("Circle forwarding budget meets or exceeds the net bridged amount.");
    }
    subUnitRemainderStroops = input.netAmount % 10n;
    const expectedDestination = input.netAmount / 10n - input.relayGas / 10n;
    if (expectedDestination <= 0n || input.destinationAmount !== expectedDestination) {
      return invalid("Circle six-decimal destination minimum does not conserve net bridged units.");
    }
  } else {
    if (input.destinationAmount !== input.netAmount) {
      return invalid("Axelar ITS seven-decimal destination minimum must match net bridged units.");
    }
  }

  const formatted = {
    grossAmount: formatExactAmount(input.grossAmount, 7),
    fee: formatExactAmount(input.fee, 7),
    netAmount: formatExactAmount(input.netAmount, 7),
    relayGas: formatExactAmount(input.relayGas, 7),
    destinationAmount: formatExactAmount(input.destinationAmount, destinationDecimals),
  };

  if (
    parseUnits(formatted.grossAmount, 7) !== input.grossAmount ||
    parseUnits(formatted.fee, 7) !== input.fee ||
    parseUnits(formatted.netAmount, 7) !== input.netAmount ||
    parseUnits(formatted.relayGas, 7) !== input.relayGas ||
    parseUnits(formatted.destinationAmount, destinationDecimals) !== input.destinationAmount
  ) {
    return invalid("Formatted review strings failed lossless integer roundtrip.");
  }

  return {
    valid: true,
    reason: null,
    destinationDecimals,
    subUnitRemainderStroops,
    formatted,
  };
}

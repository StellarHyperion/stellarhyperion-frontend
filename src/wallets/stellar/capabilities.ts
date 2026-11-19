import { STELLAR_WALLETS, type StellarWalletId } from "./sdk";

export type WalletAvailabilityStatus =
  "installed" | "missing_extension" | "popup_required" | "available" | "unsupported" | "unknown";

export function walletCapabilities(id: StellarWalletId) {
  return {
    id,
    name: STELLAR_WALLETS.find((wallet) => wallet.id === id)?.name ?? id,
    signingLimitations: { canSignTransaction: true, canSignAuthEntry: false },
    supportedAccountQueries: { canListenAccountChange: false },
  } as const;
}

/** Detect extension availability without requesting account access or a signature. */
export async function walletAvailability(id: StellarWalletId): Promise<WalletAvailabilityStatus> {
  if (typeof window === "undefined") return "unsupported";
  if (id === "albedo" || id === "xbull") return "popup_required";
  try {
    if (id === "freighter") {
      const api = await import("@stellar/freighter-api");
      return (await api.isConnected()).isConnected ? "installed" : "missing_extension";
    }
    const api = await import("@lobstrco/signer-extension-api");
    return (await api.isConnected()) ? "installed" : "missing_extension";
  } catch {
    return "unknown";
  }
}

export function walletAvailabilityLabel(status: WalletAvailabilityStatus): string {
  return {
    installed: "installed",
    missing_extension: "extension not detected",
    popup_required: "opens a wallet popup",
    available: "connected",
    unsupported: "unavailable here",
    unknown: "availability unknown",
  }[status];
}

export class UnsupportedWalletMethodError extends Error {
  constructor(id: StellarWalletId, method: string) {
    super(`${walletCapabilities(id).name} does not support ${method} through this app.`);
    this.name = "UnsupportedWalletMethodError";
  }
}

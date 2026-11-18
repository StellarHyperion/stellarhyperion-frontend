import {
  AmbiguousTransactionError,
  UnsupportedWalletMethodError,
  WalletConcurrencyError,
  type StellarNetworkName,
  type WalletAvailabilityStatus,
  type WalletCapabilities,
  type WalletDiagnostics,
  type WalletKind,
} from "./types";

interface StaticWalletDefinition {
  readonly id: string;
  readonly name: string;
  readonly kind: WalletKind;
  readonly requiresExtension: boolean;
  readonly requiresPopup: boolean;
  readonly supportedAccountQueries: {
    readonly canFetchAddress: boolean;
    readonly canListenAccountChange: boolean;
    readonly canGetNetwork: boolean;
  };
  readonly signingLimitations: {
    readonly canSignTransaction: boolean;
    readonly canSignAuthEntry: boolean;
    readonly supportsBatchSigning: boolean;
    readonly maxConcurrentRequests: number;
  };
  readonly supportedLanes: readonly StellarNetworkName[];
}

export const KNOWN_STELLAR_WALLETS: readonly StaticWalletDefinition[] = [
  {
    id: "freighter",
    name: "Freighter",
    kind: "extension",
    requiresExtension: true,
    requiresPopup: false,
    supportedAccountQueries: {
      canFetchAddress: true,
      canListenAccountChange: true,
      canGetNetwork: true,
    },
    signingLimitations: {
      canSignTransaction: true,
      canSignAuthEntry: true,
      supportsBatchSigning: true,
      maxConcurrentRequests: 1,
    },
    supportedLanes: ["TESTNET"],
  },
  {
    id: "xbull",
    name: "xBull",
    kind: "extension",
    requiresExtension: true,
    requiresPopup: false,
    supportedAccountQueries: {
      canFetchAddress: true,
      canListenAccountChange: false,
      canGetNetwork: false,
    },
    signingLimitations: {
      canSignTransaction: true,
      canSignAuthEntry: false,
      supportsBatchSigning: false,
      maxConcurrentRequests: 1,
    },
    supportedLanes: ["TESTNET"],
  },
  {
    id: "albedo",
    name: "Albedo",
    kind: "popup",
    requiresExtension: false,
    requiresPopup: true,
    supportedAccountQueries: {
      canFetchAddress: true,
      canListenAccountChange: false,
      canGetNetwork: false,
    },
    signingLimitations: {
      canSignTransaction: true,
      canSignAuthEntry: false,
      supportsBatchSigning: false,
      maxConcurrentRequests: 1,
    },
    supportedLanes: ["TESTNET"],
  },
  {
    id: "lobstr",
    name: "Lobstr",
    kind: "mobile",
    requiresExtension: false,
    requiresPopup: false,
    supportedAccountQueries: {
      canFetchAddress: true,
      canListenAccountChange: false,
      canGetNetwork: false,
    },
    signingLimitations: {
      canSignTransaction: true,
      canSignAuthEntry: false,
      supportsBatchSigning: false,
      maxConcurrentRequests: 1,
    },
    supportedLanes: ["TESTNET"],
  },
] as const;

/**
 * Inspect wallet installed and available status without initiating signature requests.
 *
 * Missing extensions and popup requirements are modeled as distinct states.
 */
export function checkWalletAvailability(walletId: string): WalletAvailabilityStatus {
  const normId = walletId.toLowerCase();
  const def = KNOWN_STELLAR_WALLETS.find((w) => w.id === normId);
  if (!def) {
    return "unsupported";
  }

  if (typeof window === "undefined") {
    if (def.requiresExtension) return "missing_extension";
    if (def.requiresPopup) return "popup_required";
    return "available";
  }

  const win = window as unknown as {
    freighter?: unknown;
    stellar?: { freighter?: unknown };
    xBullSDK?: unknown;
    xbull?: unknown;
  };

  if (normId === "freighter") {
    const hasFreighter = Boolean(win.freighter || win.stellar?.freighter);
    return hasFreighter ? "installed" : "missing_extension";
  }

  if (normId === "xbull") {
    const hasXBull = Boolean(win.xBullSDK || win.xbull);
    return hasXBull ? "installed" : "missing_extension";
  }

  if (normId === "albedo") {
    return "popup_required";
  }

  if (normId === "lobstr") {
    return "available";
  }

  return "unsupported";
}

/**
 * Return resolved capabilities for a given Stellar wallet adapter.
 */
export function getWalletCapabilities(walletId: string): WalletCapabilities {
  const normId = walletId.toLowerCase();
  const def = KNOWN_STELLAR_WALLETS.find((w) => w.id === normId);
  if (!def) {
    throw new UnsupportedWalletMethodError(
      walletId,
      "lookup",
      `Wallet "${walletId}" is not recognized among supported adapters.`,
    );
  }

  const availability = checkWalletAvailability(def.id);
  return {
    walletId: def.id,
    name: def.name,
    kind: def.kind,
    availability,
    supportedAccountQueries: { ...def.supportedAccountQueries },
    signingLimitations: { ...def.signingLimitations },
    supportedLanes: [...def.supportedLanes],
    requiresPopup: def.requiresPopup,
    requiresExtension: def.requiresExtension,
  };
}

/**
 * Return capabilities for all four registered Stellar wallet adapters.
 */
export function getAllWalletCapabilities(): WalletCapabilities[] {
  return KNOWN_STELLAR_WALLETS.map((def) => getWalletCapabilities(def.id));
}

/**
 * Generate diagnostic inspection report for a wallet.
 * Never requests a signature to test availability.
 */
export function getWalletDiagnostics(walletId: string): WalletDiagnostics {
  const capabilities = getWalletCapabilities(walletId);
  return {
    walletId: capabilities.walletId,
    name: capabilities.name,
    status: capabilities.availability,
    isInstalled: capabilities.availability === "installed",
    requiresExtension: capabilities.requiresExtension,
    requiresPopup: capabilities.requiresPopup,
    capabilities,
    lastChecked: Date.now(),
  };
}

/**
 * Return diagnostic inspection reports for all supported wallets.
 */
export function getAllWalletDiagnostics(): WalletDiagnostics[] {
  return KNOWN_STELLAR_WALLETS.map((def) => getWalletDiagnostics(def.id));
}

/**
 * Validate that an adapter explicitly supports the requested method.
 *
 * Prevents silent fallback to another wallet when an unsupported method is called.
 */
export function assertWalletMethodSupported(
  walletId: string,
  method: "signTransaction" | "signAuthEntry" | "watchAccount",
): void {
  const caps = getWalletCapabilities(walletId);

  if (method === "signTransaction" && !caps.signingLimitations.canSignTransaction) {
    throw new UnsupportedWalletMethodError(
      walletId,
      method,
      `Wallet "${caps.name}" does not support transaction signing.`,
    );
  }

  if (method === "signAuthEntry" && !caps.signingLimitations.canSignAuthEntry) {
    throw new UnsupportedWalletMethodError(
      walletId,
      method,
      `Wallet "${caps.name}" does not support Soroban auth entry signing.`,
    );
  }

  if (method === "watchAccount" && !caps.supportedAccountQueries.canListenAccountChange) {
    throw new UnsupportedWalletMethodError(
      walletId,
      method,
      `Wallet "${caps.name}" does not support account change events.`,
    );
  }
}

/**
 * Guard against overlapping signing requests and concurrent state corruption.
 */
export class ConcurrencyGuard {
  private signingActive = false;
  private connectingActive = false;

  acquireSign(): void {
    if (this.signingActive) {
      throw new WalletConcurrencyError(
        "Concurrent signature request rejected: a signing operation is already pending.",
      );
    }
    this.signingActive = true;
  }

  releaseSign(): void {
    this.signingActive = false;
  }

  acquireConnect(): void {
    if (this.connectingActive) {
      throw new WalletConcurrencyError(
        "Concurrent connection request rejected: a connection attempt is already pending.",
      );
    }
    this.connectingActive = true;
  }

  releaseConnect(): void {
    this.connectingActive = false;
  }

  get isSigning(): boolean {
    return this.signingActive;
  }

  get isConnecting(): boolean {
    return this.connectingActive;
  }
}

/**
 * Explicit account change subscription.
 * Registers listener only if adapter declares support; otherwise provides safe no-op.
 */
export function subscribeToAccountChange(
  walletId: string,
  onAddressChange: (newAddress: string | null) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  let caps: WalletCapabilities;
  try {
    caps = getWalletCapabilities(walletId);
  } catch {
    return () => {};
  }

  if (!caps.supportedAccountQueries.canListenAccountChange) {
    return () => {};
  }

  const handler = (event: Event) => {
    const custom = event as CustomEvent<{ address?: string | null }>;
    if (custom.detail && "address" in custom.detail) {
      onAddressChange(custom.detail.address ?? null);
    }
  };

  window.addEventListener("freighter:accountChange", handler);
  return () => {
    window.removeEventListener("freighter:accountChange", handler);
  };
}

export {
  AmbiguousTransactionError,
  UnsupportedWalletMethodError,
  WalletConcurrencyError,
};

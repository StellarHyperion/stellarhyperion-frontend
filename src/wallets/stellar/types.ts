export type StellarNetworkName = "TESTNET" | "PUBLIC";

export type StellarWalletId = "freighter" | "xbull" | "albedo" | "lobstr" | string;

export type WalletKind = "extension" | "popup" | "mobile" | "web";

export type WalletAvailabilityStatus =
  | "installed"
  | "missing_extension"
  | "popup_required"
  | "available"
  | "unsupported";

export interface WalletAccountQueries {
  canFetchAddress: boolean;
  canListenAccountChange: boolean;
  canGetNetwork: boolean;
}

export interface WalletSigningLimitations {
  canSignTransaction: boolean;
  canSignAuthEntry: boolean;
  supportsBatchSigning: boolean;
  maxConcurrentRequests: number;
}

export interface WalletCapabilities {
  walletId: string;
  name: string;
  kind: WalletKind;
  availability: WalletAvailabilityStatus;
  supportedAccountQueries: WalletAccountQueries;
  signingLimitations: WalletSigningLimitations;
  supportedLanes: readonly StellarNetworkName[];
  requiresPopup: boolean;
  requiresExtension: boolean;
}

export interface WalletDiagnostics {
  walletId: string;
  name: string;
  status: WalletAvailabilityStatus;
  isInstalled: boolean;
  requiresExtension: boolean;
  requiresPopup: boolean;
  capabilities: WalletCapabilities;
  lastChecked: number;
}

export class UnsupportedWalletMethodError extends Error {
  readonly walletId: string;
  readonly method: string;

  constructor(walletId: string, method: string, message?: string) {
    super(message ?? `Wallet "${walletId}" does not support method "${method}".`);
    this.name = "UnsupportedWalletMethodError";
    this.walletId = walletId;
    this.method = method;
  }
}

export class WalletConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletConcurrencyError";
  }
}

export class AmbiguousTransactionError extends Error {
  readonly txHash?: string;

  constructor(message: string, txHash?: string) {
    super(message);
    this.name = "AmbiguousTransactionError";
    this.txHash = txHash;
  }
}

export interface SupportedStellarWallet {
  id: string;
  name: string;
  icon?: string;
  isAvailable?: boolean;
  availability?: WalletAvailabilityStatus;
  capabilities?: WalletCapabilities;
}

export interface StellarWalletContextValue {
  address: string | null;
  shortAddress: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  isSigning: boolean;
  walletId: string | null;
  network: StellarNetworkName;
  error: string | null;
  activeCapabilities: WalletCapabilities | null;
  wallets: WalletCapabilities[];
  connect: (preferredWalletId?: string) => Promise<string | null>;
  disconnect: () => Promise<void>;
  signTransaction: (
    xdr: string,
    opts?: { networkPassphrase?: string },
  ) => Promise<{ signedTxXdr: string }>;
  signAuthEntry: (
    entryXdr: string,
    opts?: { networkPassphrase?: string },
  ) => Promise<{ signedAuthEntry: string }>;
  setNetwork: (network: StellarNetworkName) => void;
  getDiagnostics: (walletId?: string) => WalletDiagnostics | WalletDiagnostics[];
  onAccountChange: (handler: (newAddress: string | null) => void) => () => void;
}

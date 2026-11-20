import type { PendingSigningRequest, SigningOperation } from "./sdk";
export type StellarApprovalOperation = "conversion" | "bridge" | "claim-settlement";

export interface WalletApprovalProvenance {
  account: string;
  network: string;
  operation: StellarApprovalOperation;
}

export type WalletInteractionMode = "connected" | "read-only" | "disconnected";

export interface StellarWalletContextValue {
  address: string | null;
  shortAddress: string | null;
  viewedAddress: string | null;
  connectedAddress: string | null;
  walletId: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  isSigning: boolean;
  isReadOnly: boolean;
  mode: WalletInteractionMode;
  reconciliationRequired: boolean;
  error: string | null;
  readOnlyError: string | null;
  // True only when the wallet is connected and its reported network agrees with Stellar Testnet.
  // If the RPC network and the wallet network disagree, the state must never be ready.
  isReady: boolean;
  // Non-null when the wallet reports a network that is not Stellar Testnet, or when the wallet
  // network and the RPC network are known to disagree. Signing is blocked while this is set.
  // The message is actionable: it names what the user must do to resolve the mismatch.
  networkMismatch: string | null;
  rememberedWallet: string | null;
  preferenceError: string | null;
  clearRememberedWallet: () => void;
  pendingSigningRequest: PendingSigningRequest | null;
  connect: () => Promise<string | null>;
  disconnect: () => Promise<void>;
  inspectAddress: (address: string) => Promise<boolean>;
  clearReadOnly: () => void;
  reconcileMode: (target: "connected" | "viewed") => void;
  reconcileToConnected: () => void;
  reconcileToViewed: () => void;
  setReadOnlyError: (error: string | null) => void;
  signTransaction: (
    xdr: string,
    opts?: {
      networkPassphrase?: string;
      operation?: SigningOperation;
      approval?: WalletApprovalProvenance;
    },
  ) => Promise<{ signedTxXdr: string }>;
  // Explicitly abandons any outstanding signature request(s), resolving them to a clear failure
  // instead of leaving the signing controls locked. Never resubmits and never assumes success.
  cancelSignature: () => void;
}

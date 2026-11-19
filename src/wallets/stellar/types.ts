import type { PendingSigningRequest, SigningOperation } from "./sdk";
export type StellarApprovalOperation = "conversion" | "bridge" | "claim-settlement";

export interface WalletApprovalProvenance {
  account: string;
  network: string;
  operation: StellarApprovalOperation;
}

export interface StellarWalletContextValue {
  address: string | null;
  shortAddress: string | null;
  walletId: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  rememberedWallet: string | null;
  preferenceError: string | null;
  clearRememberedWallet: () => void;
  pendingSigningRequest: PendingSigningRequest | null;
  connect: () => Promise<string | null>;
  disconnect: () => Promise<void>;
  signTransaction: (
    xdr: string,
    opts?: {
      networkPassphrase?: string;
      operation?: SigningOperation;
      approval?: WalletApprovalProvenance;
    },
  ) => Promise<{ signedTxXdr: string }>;
}

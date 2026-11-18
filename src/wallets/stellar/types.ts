import type { PendingSigningRequest, SigningOperation } from "./sdk";

export interface StellarWalletContextValue {
  address: string | null;
  shortAddress: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  pendingSigningRequest: PendingSigningRequest | null;
  connect: () => Promise<string | null>;
  disconnect: () => Promise<void>;
  signTransaction: (
    xdr: string,
    opts?: { networkPassphrase?: string; operation?: SigningOperation },
  ) => Promise<{ signedTxXdr: string }>;
}

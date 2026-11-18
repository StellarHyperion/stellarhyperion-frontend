import type { StellarWalletId } from "./sdk";

export interface StellarWalletContextValue {
  address: string | null;
  shortAddress: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  rememberedWallet: StellarWalletId | null;
  preferenceError: string | null;
  connect: () => Promise<string | null>;
  disconnect: () => Promise<void>;
  clearRememberedWallet: () => void;
  signTransaction: (
    xdr: string,
    opts?: { networkPassphrase?: string },
  ) => Promise<{ signedTxXdr: string }>;
}

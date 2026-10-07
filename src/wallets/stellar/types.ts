export type StellarNetworkName = "TESTNET" | "PUBLIC";

export interface SupportedStellarWallet {
  id: string;
  name: string;
  icon?: string;
  isAvailable?: boolean;
}

export interface StellarWalletContextValue {
  address: string | null;
  shortAddress: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  walletId: string | null;
  network: StellarNetworkName;
  error: string | null;
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
}

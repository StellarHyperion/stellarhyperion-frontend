export interface StellarWalletContextValue {
  address: string | null;
  shortAddress: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  // True while a signature request is outstanding with the connected wallet. Surfaced so the UI
  // can show the pending approval and offer an explicit way out if the wallet goes silent.
  isSigning: boolean;
  error: string | null;
  connect: () => Promise<string | null>;
  disconnect: () => Promise<void>;
  signTransaction: (
    xdr: string,
    opts?: { networkPassphrase?: string },
  ) => Promise<{ signedTxXdr: string }>;
  // Explicitly abandons any outstanding signature request(s), resolving them to a clear failure
  // instead of leaving the signing controls locked. Never resubmits and never assumes success.
  cancelSignature: () => void;
}

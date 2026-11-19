"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { StellarWalletContextValue, WalletApprovalProvenance } from "./types";
import { TESTNET } from "../../config/testnet";

import { Dialog } from "../../components/common/Dialog";
import {
  STELLAR_WALLETS,
  isWalletId,
  walletAddress,
  walletSign,
  createSigningCoordinator,
  type StellarWalletId,
  type PendingSigningRequest,
} from "./sdk";
import styles from "./WalletPicker.module.css";

import {
  walletAvailability,
  walletAvailabilityLabel,
  type WalletAvailabilityStatus,
} from "./capabilities";

import {
  isRecognizedWalletPreference,
  readWalletPreference,
  saveWalletPreference,
} from "./preference";

const Context = createContext<StellarWalletContextValue | null>(null);

export function StellarWalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const restorationAllowed = useRef(true);
  const [rememberedWallet, setRememberedWallet] = useState<StellarWalletId | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<StellarWalletId | null>(null);
  const [isConnecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [availability, setAvailability] = useState<
    Partial<Record<StellarWalletId, WalletAvailabilityStatus>>
  >({});
  useEffect(() => {
    if (!pickerOpen) return;
    let active = true;
    for (const wallet of STELLAR_WALLETS)
      void walletAvailability(wallet.id).then((status) => {
        if (active) setAvailability((current) => ({ ...current, [wallet.id]: status }));
      });
    return () => {
      active = false;
    };
  }, [pickerOpen]);
  const [authorizing, setAuthorizing] = useState<StellarWalletId | null>(null);
  const [pendingSigningRequest, setPendingSigningRequest] = useState<PendingSigningRequest | null>(
    null,
  );
  const coordinator = useRef(createSigningCoordinator(setPendingSigningRequest));
  const pending = useRef<((address: string | null) => void) | null>(null);
  const attempt = useRef(0);

  useEffect(() => {
    let active = true;
    const version = attempt.current;
    // Hydrate browser storage after mount; cleanup also covers strict-mode remounts.
    queueMicrotask(() => {
      if (!active) return;
      const preference = readWalletPreference();
      const saved = preference.id;
      setRememberedWallet(isWalletId(saved) ? saved : null);
      setPreferenceError(
        preference.error ??
          (!isRecognizedWalletPreference(saved)
            ? "The saved wallet preference is not recognized. Clear it before connecting."
            : null),
      );
      // Only Freighter offers a silent address lookup. Other wallets require a user gesture.
      if (isWalletId(saved) && saved === "freighter")
        void walletAddress(saved, false)
          .then((value) => {
            if (active && restorationAllowed.current && attempt.current === version) {
              setAddress(value);
              setWalletId(saved);
            }
          })
          .catch(() => {
            /* Explicit connection remains available. */
          });
    });
    return () => {
      active = false;
    };
  }, []);

  const closePicker = useCallback(() => {
    attempt.current++;
    pending.current?.(null);
    pending.current = null;
    setPickerOpen(false);
    setAuthorizing(null);
    setConnecting(false);
    setError(null);
  }, []);

  const connect = useCallback(async () => {
    if (pending.current) return null;
    attempt.current++;
    setConnecting(true);
    setError(null);
    setAvailability({});
    setPickerOpen(true);
    return await new Promise<string | null>((resolve) => {
      pending.current = resolve;
    });
  }, []);

  const chooseWallet = async (id: StellarWalletId) => {
    if (authorizing || !pending.current) return;
    const version = attempt.current;
    setAuthorizing(id);
    setError(null);
    try {
      const value = await walletAddress(id);
      if (attempt.current !== version) return;
      setAddress(value);
      setWalletId(id);
      const storageError = saveWalletPreference(id);
      setPreferenceError(storageError);
      if (!storageError) setRememberedWallet(id);
      pending.current(value);
      pending.current = null;
      setPickerOpen(false);
      setConnecting(false);
    } catch (cause) {
      if (attempt.current === version)
        setError(cause instanceof Error ? cause.message : "Wallet connection was declined.");
    } finally {
      if (attempt.current === version) setAuthorizing(null);
    }
  };

  const disconnect = useCallback(() => {
    closePicker();
    setAddress(null);
    setWalletId(null);
    const storageError = saveWalletPreference(null);
    setPreferenceError(storageError);
    if (!storageError) setRememberedWallet(null);
    return Promise.resolve();
  }, [closePicker]);

  const clearRememberedWallet = useCallback(() => {
    // Clear only the preference. An explicit connection or signed checkpoint stays intact.
    restorationAllowed.current = false;
    const storageError = saveWalletPreference(null);
    setPreferenceError(storageError);
    if (!storageError) setRememberedWallet(null);
  }, []);

  const signTransaction = useCallback(
    async (
      transaction: string,
      opts?: {
        networkPassphrase?: string;
        operation?: PendingSigningRequest["operation"];
        approval?: WalletApprovalProvenance;
      },
    ) => {
      if (!address || !walletId) throw new Error("Connect your Stellar wallet first.");
      if (opts?.networkPassphrase && opts.networkPassphrase !== TESTNET.networkPassphrase)
        throw new Error("Hyperion signs Stellar Testnet transactions only.");
      if (opts?.approval && opts.approval.account !== address)
        throw new Error("The wallet account changed. Review the transaction again.");
      return coordinator.current.run(
        {
          operation: opts?.approval?.operation ?? opts?.operation ?? "transaction",
          account: address,
        },
        () => walletSign(walletId, transaction, address, opts?.approval),
      );
    },
    [address, walletId],
  );

  const value = useMemo(
    () => ({
      address,
      shortAddress: address ? `${address.slice(0, 6)}...${address.slice(-6)}` : null,
      walletId,
      isConnected: address !== null,
      isConnecting,
      error,
      rememberedWallet,
      preferenceError,
      clearRememberedWallet,
      pendingSigningRequest,
      connect,
      disconnect,
      signTransaction,
    }),
    [
      address,
      walletId,
      isConnecting,
      error,
      rememberedWallet,
      preferenceError,
      clearRememberedWallet,
      pendingSigningRequest,
      connect,
      disconnect,
      signTransaction,
    ],
  );
  return (
    <Context.Provider value={value}>
      {children}
      {pickerOpen && (
        <Dialog title="Connect a Stellar wallet" onClose={closePicker}>
          <p className={styles.note}>
            Choose a wallet for Stellar Testnet. Your wallet keeps your keys and approves each
            signature.
          </p>
          <div className={styles.wallets}>
            {STELLAR_WALLETS.map((wallet) => (
              <div key={wallet.id} className={styles.row}>
                <button
                  type="button"
                  disabled={authorizing !== null}
                  onClick={() => void chooseWallet(wallet.id)}
                >
                  {authorizing === wallet.id ? `Connecting to ${wallet.name}...` : wallet.name}
                </button>
                <span role="status">
                  {walletAvailabilityLabel(availability[wallet.id] ?? "unknown")}
                </span>
                <a
                  href={wallet.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open ${wallet.name} website`}
                >
                  Get wallet
                </a>
              </div>
            ))}
          </div>
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
        </Dialog>
      )}
    </Context.Provider>
  );
}

export function useStellarWallet() {
  const value = useContext(Context);
  if (!value) throw new Error("useStellarWallet requires StellarWalletProvider.");
  return value;
}

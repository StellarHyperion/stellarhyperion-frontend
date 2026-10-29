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
import type { StellarWalletContextValue } from "./types";
import { TESTNET } from "../../config/testnet";

import { Dialog } from "../../components/common/Dialog";
import {
  STELLAR_WALLETS,
  isWalletId,
  walletAddress,
  walletSign,
  type StellarWalletId,
} from "./sdk";
import styles from "./WalletPicker.module.css";

const WALLET_KEY = "hyperion.stellar.walletId";
function readSavedWallet(): string | null {
  try {
    return localStorage.getItem(WALLET_KEY);
  } catch {
    return null;
  }
}
function saveWallet(id: string | null) {
  try {
    if (id) localStorage.setItem(WALLET_KEY, id);
    else localStorage.removeItem(WALLET_KEY);
  } catch {
    /* Wallet access still works without browser storage. */
  }
}
const Context = createContext<StellarWalletContextValue | null>(null);

export function StellarWalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<StellarWalletId | null>(null);
  const [isConnecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [authorizing, setAuthorizing] = useState<StellarWalletId | null>(null);
  const pending = useRef<((address: string | null) => void) | null>(null);
  const attempt = useRef(0);

  useEffect(() => {
    let active = true;
    const version = attempt.current;
    const saved = readSavedWallet();
    // Only Freighter offers a silent address lookup. Other wallets require a user gesture.
    if (isWalletId(saved) && saved === "freighter")
      void walletAddress(saved, false)
        .then((value) => {
          if (active && attempt.current === version) {
            setAddress(value);
            setWalletId(saved);
          }
        })
        .catch(() => {
          /* Explicit connection remains available. */
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
      saveWallet(id);
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
    saveWallet(null);
    return Promise.resolve();
  }, [closePicker]);

  const signTransaction = useCallback(
    async (transaction: string, opts?: { networkPassphrase?: string }) => {
      if (!address || !walletId) throw new Error("Connect your Stellar wallet first.");
      if (opts?.networkPassphrase && opts.networkPassphrase !== TESTNET.networkPassphrase)
        throw new Error("Hyperion signs Stellar Testnet transactions only.");
      return walletSign(walletId, transaction, address);
    },
    [address, walletId],
  );

  const value = useMemo(
    () => ({
      address,
      shortAddress: address ? `${address.slice(0, 6)}...${address.slice(-6)}` : null,
      isConnected: address !== null,
      isConnecting,
      error,
      connect,
      disconnect,
      signTransaction,
    }),
    [address, isConnecting, error, connect, disconnect, signTransaction],
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

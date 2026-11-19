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
  walletCurrentAddress,
  walletSign,
  type StellarWalletId,
} from "./sdk";
import {
  isRecognizedWalletPreference,
  readWalletPreference,
  saveWalletPreference,
} from "./preference";
import styles from "./WalletPicker.module.css";

const Context = createContext<StellarWalletContextValue | null>(null);

export function StellarWalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<StellarWalletId | null>(null);
  const [rememberedWallet, setRememberedWallet] = useState<StellarWalletId | null>(null);
  const [isConnecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [authorizing, setAuthorizing] = useState<StellarWalletId | null>(null);
  const pending = useRef<((address: string | null) => void) | null>(null);
  const attempt = useRef(0);
  const addressRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const version = attempt.current;
    const preference = readWalletPreference();
    const saved = preference.id;
    if (active) {
      setRememberedWallet(isWalletId(saved) ? saved : null);
      setPreferenceError(
        preference.error ??
          (!isRecognizedWalletPreference(saved)
            ? "The saved wallet preference is not recognized. Clear it before connecting."
            : null),
      );
    }
    // Only Freighter offers a silent address lookup. Other wallets require a user gesture.
    if (isWalletId(saved) && saved === "freighter")
      void walletAddress(saved, false)
        .then((value) => {
          if (active && attempt.current === version) {
            addressRef.current = value;
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

  const invalidateAccount = useCallback((expectedAddress: string, message: string) => {
    if (addressRef.current !== expectedAddress) return;
    attempt.current++;
    addressRef.current = null;
    pending.current?.(null);
    pending.current = null;
    setAddress(null);
    setWalletId(null);
    setConnecting(false);
    setPickerOpen(false);
    setAuthorizing(null);
    setError(message);
  }, []);

  useEffect(() => {
    if (!address || !walletId) return;
    let active = true;
    let checking = false;
    const verifyAccount = async () => {
      if (checking) return;
      checking = true;
      try {
        const current = await walletCurrentAddress(walletId);
        if (!active || addressRef.current !== address || current === undefined) return;
        setError((message) =>
          message?.startsWith("Could not verify your wallet account:") ? null : message,
        );
        if (current === address) return;
        invalidateAccount(
          address,
          current
            ? "Your Stellar wallet account changed. Reconnect before reviewing or signing."
            : "Your Stellar wallet disconnected. Reconnect before reviewing or signing.",
        );
      } catch (cause) {
        if (active && addressRef.current === address)
          setError(
            `Could not verify your wallet account: ${
              cause instanceof Error ? cause.message : "unknown wallet error"
            }`,
          );
      } finally {
        checking = false;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void verifyAccount();
    };
    window.addEventListener("focus", verifyAccount);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const timer = window.setInterval(() => void verifyAccount(), 5000);
    return () => {
      active = false;
      window.removeEventListener("focus", verifyAccount);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(timer);
    };
  }, [address, walletId, invalidateAccount]);

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
      addressRef.current = value;
      setAddress(value);
      setWalletId(id);
      const storageError = saveWalletPreference(id);
      if (storageError) setPreferenceError(storageError);
      else {
        setRememberedWallet(id);
        setPreferenceError(null);
      }
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
    addressRef.current = null;
    setAddress(null);
    setWalletId(null);
    const storageError = saveWalletPreference(null);
    if (storageError) setPreferenceError(storageError);
    else {
      setRememberedWallet(null);
      setPreferenceError(null);
    }
    return Promise.resolve();
  }, [closePicker]);

  const clearRememberedWallet = useCallback(() => {
    const storageError = saveWalletPreference(null);
    if (storageError) {
      setPreferenceError(storageError);
      return;
    }
    setRememberedWallet(null);
    setPreferenceError(null);
  }, []);

  const signTransaction = useCallback(
    async (transaction: string, opts?: { networkPassphrase?: string }) => {
      if (!address || !walletId) throw new Error("Connect your Stellar wallet first.");
      if (opts?.networkPassphrase && opts.networkPassphrase !== TESTNET.networkPassphrase)
        throw new Error("Hyperion signs Stellar Testnet transactions only.");
      if (addressRef.current !== address)
        throw new Error("Your wallet account changed. Connect again.");
      const currentAddress = await walletCurrentAddress(walletId);
      if (currentAddress !== undefined && currentAddress !== address) {
        invalidateAccount(
          address,
          "Your Stellar wallet account changed. Reconnect before reviewing or signing.",
        );
        throw new Error("Your wallet account changed. Connect again.");
      }
      return walletSign(walletId, transaction, address);
    },
    [address, walletId, invalidateAccount],
  );

  const value = useMemo(
    () => ({
      address,
      shortAddress: address ? `${address.slice(0, 6)}...${address.slice(-6)}` : null,
      isConnected: address !== null,
      isConnecting,
      error,
      rememberedWallet,
      preferenceError,
      connect,
      disconnect,
      clearRememberedWallet,
      signTransaction,
    }),
    [
      address,
      isConnecting,
      error,
      rememberedWallet,
      preferenceError,
      connect,
      disconnect,
      clearRememberedWallet,
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

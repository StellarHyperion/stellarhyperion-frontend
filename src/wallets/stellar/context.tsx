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
import type {
  StellarWalletContextValue,
  WalletApprovalProvenance,
  WalletInteractionMode,
} from "./types";
import { TESTNET } from "../../config/testnet";

import { Dialog } from "../../components/common/Dialog";
import {
  STELLAR_WALLETS,
  createGenerationTracker,
  createSigningCoordinator,
  isWalletId,
  validateStellarAddress,
  walletAddress,
  walletSign,
  type StellarWalletId,
  type PendingSigningRequest,
} from "./sdk";
import { assertSigningAuthorized } from "./signature";
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

const VIEWED_KEY = "hyperion.stellar.viewedAddress";

function readSavedViewedAddress(): string | null {
  try {
    return localStorage.getItem(VIEWED_KEY);
  } catch {
    return null;
  }
}
function saveViewedAddress(addr: string | null) {
  try {
    if (addr) localStorage.setItem(VIEWED_KEY, addr);
    else localStorage.removeItem(VIEWED_KEY);
  } catch {
    /* Safe without browser storage. */
  }
}

const Context = createContext<StellarWalletContextValue | null>(null);

export function StellarWalletProvider({ children }: { children: ReactNode }) {
  const [connectedAddress, setConnectedAddress] = useState<string | null>(null);
  const [viewedAddress, setViewedAddress] = useState<string | null>(readSavedViewedAddress);
  const restorationAllowed = useRef(true);
  const [rememberedWallet, setRememberedWallet] = useState<StellarWalletId | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<StellarWalletId | null>(null);
  const [isConnecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readOnlyError, setReadOnlyError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [inspectInput, setInspectInput] = useState("");
  const [availability, setAvailability] = useState<
    Partial<Record<StellarWalletId, WalletAvailabilityStatus>>
  >({});

  const reconciliationRequired =
    connectedAddress !== null && viewedAddress !== null && connectedAddress !== viewedAddress;

  const isReadOnly =
    viewedAddress !== null && (walletId === null || viewedAddress !== connectedAddress);

  const isConnected = connectedAddress !== null && walletId !== null && !isReadOnly;

  const address = viewedAddress ?? connectedAddress ?? null;
  const shortAddress = address ? `${address.slice(0, 6)}...${address.slice(-6)}` : null;

  const mode: WalletInteractionMode = isConnected
    ? "connected"
    : isReadOnly
      ? "read-only"
      : "disconnected";

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
  // Tracks (at most) one outstanding signing request. It can be force-settled from here on
  // disconnect or explicit cancellation, so a vanished wallet extension/popup can never leave
  // this locked forever.
  const coordinator = useRef(createSigningCoordinator(setPendingSigningRequest));
  const pending = useRef<((address: string | null) => void) | null>(null);
  const attempt = useRef(0);
  // Identifies the currently bound address/wallet pair. Advances whenever the active
  // connection changes (silent restore, explicit connect, switch, or disconnect). A signing
  // request captures this generation before it asks the wallet to sign, and refuses to hand
  // back the result if the generation has since moved on - so a slow wallet response can
  // never be applied to, or silently resubmitted under, a connection it was not issued for.
  const connectionGeneration = useRef(createGenerationTracker());

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
        void connectionGeneration.current
          .run(() => walletAddress(saved, false))
          .then((value) => {
            if (active && restorationAllowed.current && attempt.current === version) {
              setConnectedAddress(value);
              setWalletId(saved);
              if (!readSavedViewedAddress()) {
                setViewedAddress(value);
              }
              connectionGeneration.current.advance();
            }
          })
          .catch(() => {
            /* Explicit connection remains available. */
          });
    });
    return () => {
      active = false;
      attempt.current++;
      connectionGeneration.current.advance();
      coordinator.current.abandon(new Error("Wallet connection closed before signing completed."));
      pending.current?.(null);
      pending.current = null;
    };
  }, []);

  const closePicker = useCallback(() => {
    attempt.current++;
    connectionGeneration.current.advance();
    pending.current?.(null);
    pending.current = null;
    setPickerOpen(false);
    setAuthorizing(null);
    setConnecting(false);
    setError(null);
  }, []);

  const connect = useCallback(async () => {
    if (pending.current) return null;
    connectionGeneration.current.advance();
    coordinator.current.abandon(
      new Error("Your wallet connection changed. Review the transaction again."),
    );
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
      const value = await connectionGeneration.current.run(() => walletAddress(id));
      if (attempt.current !== version) return;
      setConnectedAddress(value);
      setWalletId(id);
      connectionGeneration.current.advance();
      const storageError = saveWalletPreference(id);
      setPreferenceError(storageError);
      if (!storageError) setRememberedWallet(id);
      setViewedAddress((current) => {
        const next = current ?? value;
        saveViewedAddress(next);
        return next;
      });
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

  const inspectAddress = useCallback(async (raw: string): Promise<boolean> => {
    try {
      const validated = await validateStellarAddress(raw);
      setViewedAddress(validated);
      saveViewedAddress(validated);
      setReadOnlyError(null);
      return true;
    } catch (cause) {
      setReadOnlyError(
        cause instanceof Error ? cause.message : "Enter a valid Stellar public address (G...).",
      );
      return false;
    }
  }, []);

  const clearReadOnly = useCallback(() => {
    setViewedAddress(connectedAddress);
    saveViewedAddress(connectedAddress);
    setReadOnlyError(null);
  }, [connectedAddress]);

  const reconcileMode = useCallback(
    (target: "connected" | "viewed") => {
      if (target === "connected") {
        if (connectedAddress) {
          setViewedAddress(connectedAddress);
          saveViewedAddress(connectedAddress);
          setReadOnlyError(null);
        }
      } else {
        setConnectedAddress(null);
        setWalletId(null);
        const storageError = saveWalletPreference(null);
        setPreferenceError(storageError);
        if (!storageError) setRememberedWallet(null);
        setError(null);
      }
    },
    [connectedAddress],
  );

  const reconcileToConnected = useCallback(() => {
    reconcileMode("connected");
  }, [reconcileMode]);
  const reconcileToViewed = useCallback(() => {
    reconcileMode("viewed");
  }, [reconcileMode]);

  const disconnect = useCallback(() => {
    closePicker();
    connectionGeneration.current.advance();
    // A pending approval must never be left to resolve against a wallet we've already walked
    // away from: settle it to an explicit failure instead of letting it hang or complete silently.
    coordinator.current.abandon(
      new Error(
        "Wallet disconnected before the signature completed. Close any old wallet prompt, reconnect and review the transfer.",
      ),
    );
    setConnectedAddress(null);
    setViewedAddress(null);
    saveViewedAddress(null);
    setWalletId(null);
    setError(null);
    setReadOnlyError(null);
    const storageError = saveWalletPreference(null);
    setPreferenceError(storageError);
    if (!storageError) setRememberedWallet(null);
    return Promise.resolve();
  }, [closePicker]);

  const cancelSignature = useCallback(() => {
    coordinator.current.abandon(
      new Error(
        "Stopped waiting for this signature. Close the wallet prompt and review before trying again.",
      ),
    );
  }, []);

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
      assertSigningAuthorized({
        account: address ?? "",
        walletId,
        isReadOnly,
        connectedAccount: connectedAddress,
        viewedAddress,
      });
      if (!connectedAddress || !walletId) throw new Error("Connect your Stellar wallet first.");
      if (opts?.networkPassphrase && opts.networkPassphrase !== TESTNET.networkPassphrase)
        throw new Error("Hyperion signs Stellar Testnet transactions only.");
      if (opts?.approval && opts.approval.account !== connectedAddress)
        throw new Error("The wallet account changed. Review the transaction again.");
      const generation = connectionGeneration.current.value();
      const result = await coordinator.current.run(
        {
          operation: opts?.approval?.operation ?? opts?.operation ?? "transaction",
          account: connectedAddress,
        },
        (signal) =>
          connectionGeneration.current.run((connectionSignal) =>
            walletSign(walletId, transaction, connectedAddress, opts?.approval, {
              isReadOnly,
              connectedAccount: connectedAddress,
              signal: AbortSignal.any([signal, connectionSignal]),
            }),
          ),
      );
      // The wallet took long enough to respond that the user disconnected or switched
      // accounts in the meantime. Never hand back a signature bound to a connection that is
      // no longer current - the caller must not treat it as valid, and it must never be
      // auto-resubmitted.
      if (connectionGeneration.current.value() !== generation)
        throw new Error(
          "Your wallet connection changed before signing finished. Review and sign again.",
        );
      return result;
    },
    [address, connectedAddress, walletId, isReadOnly, viewedAddress],
  );

  const value = useMemo(
    () => ({
      address,
      shortAddress,
      viewedAddress,
      connectedAddress,
      walletId,
      isConnected,
      isConnecting,
      isSigning: pendingSigningRequest !== null,
      isReadOnly,
      mode,
      reconciliationRequired,
      error,
      readOnlyError,
      rememberedWallet,
      preferenceError,
      clearRememberedWallet,
      pendingSigningRequest,
      connect,
      disconnect,
      inspectAddress,
      clearReadOnly,
      reconcileMode,
      reconcileToConnected,
      reconcileToViewed,
      setReadOnlyError,
      signTransaction,
      cancelSignature,
    }),
    [
      address,
      shortAddress,
      viewedAddress,
      connectedAddress,
      walletId,
      isConnected,
      isConnecting,
      isReadOnly,
      mode,
      reconciliationRequired,
      error,
      readOnlyError,
      rememberedWallet,
      preferenceError,
      clearRememberedWallet,
      pendingSigningRequest,
      connect,
      disconnect,
      inspectAddress,
      clearReadOnly,
      reconcileMode,
      reconcileToConnected,
      reconcileToViewed,
      setReadOnlyError,
      signTransaction,
      cancelSignature,
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
                  onClick={() => {
                    void chooseWallet(wallet.id);
                  }}
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

          <div className={styles.readOnlySection}>
            <p className={styles.note}>
              Or inspect an account in read-only mode without connecting a wallet:
            </p>
            <form
              className={styles.readOnlyForm}
              onSubmit={(e) => {
                e.preventDefault();
                void (async () => {
                  const ok = await inspectAddress(inspectInput);
                  if (ok) {
                    setInspectInput("");
                    closePicker();
                  }
                })();
              }}
            >
              <input
                type="text"
                className={styles.readOnlyInput}
                placeholder="Public address (G...)"
                aria-label="Stellar public address for read-only inspection"
                value={inspectInput}
                onChange={(e) => {
                  setInspectInput(e.target.value);
                }}
              />
              <button type="submit" className={styles.readOnlyButton}>
                Inspect
              </button>
            </form>
            {readOnlyError && (
              <p role="alert" className={styles.readOnlyError}>
                {readOnlyError}
              </p>
            )}
          </div>
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

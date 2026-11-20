"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { StellarWalletContextValue, WalletApprovalProvenance } from "./types";
import { TESTNET } from "../../config/testnet";
import { assertWalletNetwork } from "./signature";

import { Dialog } from "../../components/common/Dialog";
import {
  STELLAR_WALLETS,
  createGenerationTracker,
  createSigningCoordinator,
  isWalletId,
  walletAddress,
  walletNetwork,
  walletCurrentAddress,
  walletSign,
  walletErrorGuidance,
  type StellarWalletId,
  type PendingSigningRequest,
} from "./sdk";
import styles from "./WalletPicker.module.css";
import { WalletConnectionRecovery } from "./WalletConnectionRecovery";
import type { WalletConnectionGuidance } from "./sdk";

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
  const addressRef = useRef<string | null>(null);
  const restorationAllowed = useRef(true);
  const [rememberedWallet, setRememberedWallet] = useState<StellarWalletId | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<StellarWalletId | null>(null);
  const [isConnecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionFailure, setConnectionFailure] = useState<{
    wallet: StellarWalletId;
    guidance: WalletConnectionGuidance;
  } | null>(null);
  const firstWallet = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerOpener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (pickerOpen) return;
    const opener = pickerOpener.current;
    pickerOpener.current = null;
    if (opener?.isConnected) opener.focus();
  }, [pickerOpen]);
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
  // Non-null when a periodic network check detects that the wallet is not on Stellar Testnet.
  // Signing is blocked while this is set. The message is actionable so the user knows what to fix.
  const [networkMismatch, setNetworkMismatch] = useState<string | null>(null);
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

  // Poll the wallet's reported network every 4 seconds while connected. This catches a user
  // switching the wallet to mainnet mid-session before they reach the signing step. The state
  // is also checked synchronously inside signTransaction so signing is always blocked when the
  // networks disagree, regardless of poll timing.
  //
  // walletNetwork() returns null for wallets that do not expose a network query API (Albedo,
  // xBull). For those adapters the network is enforced cryptographically at sign time instead.
  useEffect(() => {
    if (!walletId || !address) return;
    const controller = new AbortController();
    const check = async () => {
      try {
        const passphrase = await walletNetwork(walletId, controller.signal);
        if (controller.signal.aborted) return;
        if (passphrase !== null && passphrase !== TESTNET.networkPassphrase) {
          const walletName =
            STELLAR_WALLETS.find((wallet) => wallet.id === walletId)?.name ?? "Your wallet";
          setNetworkMismatch(`Switch ${walletName} to Stellar Testnet before signing.`);
        } else {
          setNetworkMismatch(null);
        }
      } catch {
        // A transient error does not set a mismatch; the sign-time check is the safety net.
      }
    };
    void check();
    const timer = setInterval(() => {
      void check();
    }, 4_000);
    return () => {
      controller.abort();
      clearInterval(timer);
      setNetworkMismatch(null);
    };
  }, [walletId, address]);

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
          .run((signal) => walletAddress(saved, false, signal))
          .then((value) => {
            if (active && restorationAllowed.current && attempt.current === version) {
              addressRef.current = value;
              setAddress(value);
              setWalletId(saved);
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
    setConnectionFailure(null);
  }, []);

  const connect = useCallback(async () => {
    if (pending.current) return null;
    pickerOpener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    connectionGeneration.current.advance();
    coordinator.current.abandon(
      new Error("Your wallet connection changed. Review the transaction again."),
    );
    attempt.current++;
    setConnecting(true);
    setError(null);
    setConnectionFailure(null);
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
    setConnectionFailure(null);
    try {
      const value = await connectionGeneration.current.run((signal) =>
        walletAddress(id, true, signal),
      );
      if (attempt.current !== version) return;
      addressRef.current = value;
      setAddress(value);
      setWalletId(id);
      connectionGeneration.current.advance();
      const storageError = saveWalletPreference(id);
      setPreferenceError(storageError);
      if (!storageError) setRememberedWallet(id);
      pending.current(value);
      pending.current = null;
      setPickerOpen(false);
      setConnecting(false);
    } catch (cause) {
      if (attempt.current === version) {
        const guidance = walletErrorGuidance(cause);
        setError(guidance.message);
        setConnectionFailure({ wallet: id, guidance });
      }
    } finally {
      if (attempt.current === version) setAuthorizing(null);
    }
  };

  const disconnect = useCallback(() => {
    closePicker();
    addressRef.current = null;
    connectionGeneration.current.advance();
    // A pending approval must never be left to resolve against a wallet we've already walked
    // away from: settle it to an explicit failure instead of letting it hang or complete silently.
    coordinator.current.abandon(
      new Error(
        "Wallet disconnected before the signature completed. Close any old wallet prompt, reconnect and review the transfer.",
      ),
    );
    setAddress(null);
    setWalletId(null);
    const storageError = saveWalletPreference(null);
    setPreferenceError(storageError);
    if (!storageError) setRememberedWallet(null);
    return Promise.resolve();
  }, [closePicker]);

  const invalidateAccount = useCallback((expectedAddress: string, message: string) => {
    if (addressRef.current !== expectedAddress) return;
    addressRef.current = null;
    attempt.current++;
    connectionGeneration.current.advance();
    coordinator.current.abandon(new Error(message));
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
      const generation = connectionGeneration.current.value();
      try {
        const current = await connectionGeneration.current.run((signal) =>
          walletCurrentAddress(walletId, signal),
        );
        if (
          !active ||
          connectionGeneration.current.value() !== generation ||
          addressRef.current !== address ||
          current === undefined
        )
          return;
        if (current !== address)
          invalidateAccount(
            address,
            "Your Stellar wallet account changed or disconnected. Reconnect before reviewing or signing.",
          );
      } catch {
        // A failed silent check cannot establish a new account. Signing performs its own bounded checks.
      } finally {
        checking = false;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void verifyAccount();
    };
    const onFocus = () => {
      void verifyAccount();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(onFocus, 5000);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
    };
  }, [address, walletId, invalidateAccount]);

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
      if (!address || !walletId) throw new Error("Connect your Stellar wallet first.");
      if (opts?.networkPassphrase && opts.networkPassphrase !== TESTNET.networkPassphrase)
        throw new Error("Hyperion signs Stellar Testnet transactions only.");
      if (opts?.approval && opts.approval.account !== address)
        throw new Error("The wallet account changed. Review the transaction again.");
      // Perform a synchronous check of the cached networkMismatch state so that a network
      // switch that was detected by the poller always blocks signing immediately. For wallets
      // that do not expose a network query API (Albedo, xBull) also do a live check here so
      // wrong-network is caught before the wallet prompt is opened.
      if (networkMismatch) throw new Error(networkMismatch);
      const livePassphrase = await walletNetwork(walletId);
      const walletName =
        STELLAR_WALLETS.find((wallet) => wallet.id === walletId)?.name ?? "Your wallet";
      assertWalletNetwork(livePassphrase, TESTNET.networkPassphrase, walletName);
      const generation = connectionGeneration.current.value();
      const result = await coordinator.current.run(
        {
          operation: opts?.approval?.operation ?? opts?.operation ?? "transaction",
          account: address,
        },
        (signal) =>
          connectionGeneration.current.run(async (connectionSignal) => {
            const combined = AbortSignal.any([signal, connectionSignal]);
            if (addressRef.current !== address)
              throw new Error("Your wallet account changed. Connect again.");
            const current = await walletCurrentAddress(walletId, combined);
            combined.throwIfAborted();
            if (current !== undefined && current !== address) {
              invalidateAccount(
                address,
                "Your Stellar wallet account changed. Reconnect before reviewing or signing.",
              );
              throw new Error("Your wallet account changed. Connect again.");
            }
            return walletSign(walletId, transaction, address, opts?.approval, combined);
          }),
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
    [address, walletId, networkMismatch, invalidateAccount],
  );

  const isReady =
    address !== null &&
    !isConnecting &&
    pendingSigningRequest === null &&
    networkMismatch === null &&
    error === null;

  const value = useMemo(
    () => ({
      address,
      shortAddress: address ? `${address.slice(0, 6)}...${address.slice(-6)}` : null,
      walletId,
      isConnected: address !== null,
      isConnecting,
      isSigning: pendingSigningRequest !== null,
      isReady,
      error,
      networkMismatch,
      rememberedWallet,
      preferenceError,
      clearRememberedWallet,
      pendingSigningRequest,
      connect,
      disconnect,
      signTransaction,
      cancelSignature,
    }),
    [
      address,
      walletId,
      isConnecting,
      isReady,
      error,
      networkMismatch,
      rememberedWallet,
      preferenceError,
      clearRememberedWallet,
      pendingSigningRequest,
      connect,
      disconnect,
      signTransaction,
      cancelSignature,
    ],
  );
  const failedWallet = connectionFailure
    ? STELLAR_WALLETS.find((wallet) => wallet.id === connectionFailure.wallet)
    : undefined;
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
                  ref={wallet.id === STELLAR_WALLETS[0].id ? firstWallet : undefined}
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
          {connectionFailure && failedWallet && (
            <WalletConnectionRecovery
              guidance={connectionFailure.guidance}
              wallet={failedWallet}
              onRetry={() => void chooseWallet(connectionFailure.wallet)}
              onChoose={() => {
                setError(null);
                setConnectionFailure(null);
                firstWallet.current?.focus();
              }}
            />
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

"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  useStellarWallet,
  isWalletId,
  walletCapabilities,
  walletAvailabilityLabel,
} from "../../wallets/stellar";
import styles from "./StellarWalletButton.module.css";

export function StellarWalletButton() {
  const {
    isConnected,
    isConnecting,
    isReadOnly,
    reconciliationRequired,
    shortAddress,
    address,
    connectedAddress,
    walletId,
    error,
    readOnlyError,
    pendingSigningRequest,
    rememberedWallet,
    preferenceError,
    clearRememberedWallet,
    connect,
    disconnect,
    inspectAddress,
    clearReadOnly,
    reconcileToConnected,
    reconcileToViewed,
    cancelSignature,
  } = useStellarWallet();
  const [menuOpen, setMenuOpen] = useState(false);
  const [inspectInput, setInspectInput] = useState("");
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const activeCapabilities = isWalletId(walletId) ? walletCapabilities(walletId) : null;
  const walletDisplayName = activeCapabilities?.name ?? "Unknown wallet";
  const rememberedWalletName = isWalletId(rememberedWallet)
    ? walletCapabilities(rememberedWallet).name
    : null;
  const preference = (rememberedWallet !== null || preferenceError !== null) && (
    <div className={styles.preference}>
      <span className={styles.addressLabel}>
        Remembered wallet: {rememberedWalletName ?? "unavailable"}
      </span>
      <button type="button" className={styles.preferenceBtn} onClick={clearRememberedWallet}>
        clear saved preference
      </button>
      {preferenceError && (
        <p role="alert" className={styles.preferenceError}>
          {preferenceError}
        </p>
      )}
    </div>
  );
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
        buttonRef.current?.focus();
      }
    }
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKey);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
        document.removeEventListener("keydown", handleKey);
      };
    }
  }, [menuOpen]);

  if (!isConnected && !isReadOnly) {
    return (
      <div className={styles.disconnected}>
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            void connect();
          }}
          disabled={isConnecting}
          aria-busy={isConnecting}
        >
          <span className={styles.dot} />
          <span>{isConnecting ? "connecting..." : "connect stellar"}</span>
        </button>
        {error && (
          <p role="alert" className={styles.preferenceError}>
            {error}
          </p>
        )}
        {readOnlyError && <span role="alert">{readOnlyError}</span>}
        {preference}
      </div>
    );
  }

  const signingLabel = pendingSigningRequest
    ? `${pendingSigningRequest.operation} signing for ${pendingSigningRequest.account.slice(0, 6)}...${pendingSigningRequest.account.slice(-6)}`
    : null;

  return (
    <div className={styles.container} ref={containerRef}>
      <button
        type="button"
        className={styles.button}
        onClick={() => {
          setMenuOpen((prev) => !prev);
        }}
        ref={buttonRef}
        aria-controls={menuId}
        aria-expanded={menuOpen}
      >
        <span className={isReadOnly ? styles.dotReadOnly : styles.dot} />
        <span>{shortAddress}</span>
        <span className={styles.network}>
          {isReadOnly ? "(read-only)" : pendingSigningRequest ? "signing..." : "(testnet)"}
        </span>
      </button>

      {preferenceError && !menuOpen && (
        <p role="alert" className={styles.preferenceNotice}>
          {preferenceError}
        </p>
      )}
      {menuOpen && (
        <div id={menuId} className={styles.menu} role="region" aria-label="Wallet details">
          <div className={styles.addressRow}>
            <span className={styles.addressLabel}>stellar account</span>
            <span className={styles.fullAddress}>{address}</span>
            {isReadOnly && (
              <>
                <span className={styles.readOnlyBadge}>read-only inspection</span>
                <p className={styles.readOnlyNote}>
                  Viewed in read-only mode. Transactions cannot be signed.
                </p>
              </>
            )}
          </div>

          {reconciliationRequired && (
            <div
              className={styles.reconciliationSection}
              role="region"
              aria-label="Mode reconciliation"
            >
              <span className={styles.reconcileTitle}>Mode reconciliation required</span>
              <p className={styles.reconcileDesc}>
                Connected wallet (
                {connectedAddress
                  ? `${connectedAddress.slice(0, 6)}...${connectedAddress.slice(-6)}`
                  : ""}
                ) differs from viewed address.
              </p>
              <div className={styles.reconcileButtons}>
                <button
                  type="button"
                  className={styles.reconcileBtn}
                  onClick={() => {
                    reconcileToConnected();
                  }}
                >
                  Use connected wallet
                </button>
                <button
                  type="button"
                  className={styles.reconcileBtn}
                  onClick={() => {
                    reconcileToViewed();
                  }}
                >
                  Keep read-only
                </button>
              </div>
            </div>
          )}

          {preference}
          <div className={styles.diagnosticsSection}>
            <span className={styles.diagTitle}>adapter diagnostics</span>

            <div className={styles.diagRow}>
              <span className={styles.diagKey}>wallet</span>
              <span className={styles.diagVal}>
                {isReadOnly ? "Read-only inspection" : walletDisplayName}
              </span>
            </div>

            <div className={styles.diagRow}>
              <span className={styles.diagKey}>availability</span>
              <span className={styles.diagVal}>
                {isReadOnly ? "read-only" : walletAvailabilityLabel("available")}
              </span>
            </div>

            <div className={styles.diagRow}>
              <span className={styles.diagKey}>tx signing</span>
              <span className={styles.diagVal}>
                {isReadOnly
                  ? "disabled (read-only)"
                  : activeCapabilities?.signingLimitations.canSignTransaction
                    ? "supported"
                    : "unsupported"}
              </span>
            </div>

            <div className={styles.diagRow}>
              <span className={styles.diagKey}>auth entry</span>
              <span className={styles.diagVal}>Unsupported by this app</span>
            </div>

            <div className={styles.diagRow}>
              <span className={styles.diagKey}>account events</span>
              <span className={styles.diagVal}>Checked before signing</span>
            </div>

            <div className={styles.diagRow}>
              <span className={styles.diagKey}>active lane</span>
              <span className={styles.diagVal}>Stellar Testnet</span>
            </div>
          </div>

          <div className={styles.inspectSection}>
            <span className={styles.diagTitle}>inspect address</span>
            <form
              className={styles.inspectInputRow}
              onSubmit={(e) => {
                e.preventDefault();
                void (async () => {
                  const ok = await inspectAddress(inspectInput);
                  if (ok) setInspectInput("");
                })();
              }}
            >
              <input
                type="text"
                className={styles.inspectInput}
                placeholder="Address (G...)"
                aria-label="Stellar address to inspect"
                value={inspectInput}
                onChange={(e) => {
                  setInspectInput(e.target.value);
                }}
              />
              <button type="submit" className={styles.inspectBtn}>
                Inspect
              </button>
            </form>
          </div>

          {readOnlyError && (
            <div role="alert" className={styles.readOnlyErrorBox}>
              {readOnlyError}
            </div>
          )}

          {error && (
            <div role="alert" className={styles.errorBox}>
              {error}
            </div>
          )}

          {isReadOnly ? (
            <>
              <button
                type="button"
                className={styles.connectWalletBtn}
                onClick={() => {
                  void connect();
                }}
              >
                Connect a wallet
              </button>
              <button
                type="button"
                className={styles.disconnectBtn}
                onClick={() => {
                  clearReadOnly();
                  setMenuOpen(false);
                }}
              >
                Exit inspection
              </button>
            </>
          ) : (
            <>
              {pendingSigningRequest && (
                <>
                  <p role="status" className={styles.addressLabel}>
                    Waiting on your wallet to approve the request. If it closed, was removed, or
                    stopped responding, stop waiting, close the wallet prompt and review before
                    trying again.
                  </p>
                  <button
                    type="button"
                    className={styles.disconnectBtn}
                    onClick={() => {
                      cancelSignature();
                    }}
                  >
                    stop waiting for signature
                  </button>
                </>
              )}
              <button
                type="button"
                className={styles.disconnectBtn}
                onClick={() => {
                  void disconnect();
                  setMenuOpen(false);
                }}
              >
                disconnect
              </button>
            </>
          )}
        </div>
      )}
      {signingLabel && (
        <span role="status" className={styles.network}>
          {signingLabel}
        </span>
      )}
    </div>
  );
}

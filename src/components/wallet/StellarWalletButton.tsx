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
    shortAddress,
    address,
    walletId,
    error,
    pendingSigningRequest,
    rememberedWallet,
    preferenceError,
    clearRememberedWallet,
    connect,
    disconnect,
  } = useStellarWallet();
  const [menuOpen, setMenuOpen] = useState(false);
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

  if (!isConnected) {
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
        <span className={styles.dot} />
        <span>{shortAddress}</span>
        <span className={styles.network}>(testnet)</span>
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
          </div>

          {preference}
          <div className={styles.diagnosticsSection}>
            <span className={styles.diagTitle}>adapter diagnostics</span>

            <div className={styles.diagRow}>
              <span className={styles.diagKey}>wallet</span>
              <span className={styles.diagVal}>{walletDisplayName}</span>
            </div>

            <div className={styles.diagRow}>
              <span className={styles.diagKey}>availability</span>
              <span className={styles.diagVal}>{walletAvailabilityLabel("available")}</span>
            </div>

            <div className={styles.diagRow}>
              <span className={styles.diagKey}>tx signing</span>
              <span className={styles.diagVal}>
                {activeCapabilities?.signingLimitations.canSignTransaction
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

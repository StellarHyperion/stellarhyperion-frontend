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
    connect,
    disconnect,
    cancelSignature,
  } = useStellarWallet();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const activeCapabilities = isWalletId(walletId) ? walletCapabilities(walletId) : null;
  const walletDisplayName = activeCapabilities?.name ?? "Unknown wallet";
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
      <button
        type="button"
        className={styles.button}
        onClick={() => {
          void connect();
        }}
        disabled={isConnecting}
      >
        <span className={styles.dot} />
        <span>{isConnecting ? "connecting..." : "connect stellar"}</span>
        {error && <span role="alert">{error}</span>}
      </button>
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
        <span className={styles.network}>{pendingSigningRequest ? "signing..." : "(testnet)"}</span>
      </button>

      {menuOpen && (
        <div id={menuId} className={styles.menu} role="region" aria-label="Wallet details">
          <div className={styles.addressRow}>
            <span className={styles.addressLabel}>stellar account</span>
            <span className={styles.fullAddress}>{address}</span>
          </div>

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

          {pendingSigningRequest && (
            <>
              <p role="status" className={styles.addressLabel}>
                Waiting on your wallet to approve the request. If it closed, was removed, or stopped
                responding, stop waiting, close the wallet prompt and review before trying again.
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

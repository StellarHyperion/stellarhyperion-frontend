"use client";

import { useEffect, useRef, useState } from "react";
import { useStellarWallet, type WalletAvailabilityStatus } from "../../wallets/stellar";
import styles from "./StellarWalletButton.module.css";

function getStatusClass(status: WalletAvailabilityStatus): string {
  switch (status) {
    case "installed":
      return styles.statusInstalled;
    case "missing_extension":
      return styles.statusMissing;
    case "popup_required":
      return styles.statusPopup;
    case "available":
      return styles.statusAvailable;
    case "unsupported":
    default:
      return styles.statusUnsupported;
  }
}

function formatStatusLabel(status: WalletAvailabilityStatus): string {
  switch (status) {
    case "installed":
      return "installed";
    case "missing_extension":
      return "missing extension";
    case "popup_required":
      return "popup required";
    case "available":
      return "available";
    case "unsupported":
    default:
      return "unsupported";
  }
}

export function StellarWalletButton() {
  const {
    isConnected,
    isConnecting,
    shortAddress,
    address,
    error,
    pendingSigningRequest,
    connect,
    disconnect,
  } = useStellarWallet();
  const [menuOpen, setMenuOpen] = useState(false);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
      };
    }
  }, [menuOpen]);

  const handleWalletSelect = async (selectedId: string, status: WalletAvailabilityStatus) => {
    setLocalNotice(null);
    if (status === "missing_extension") {
      setLocalNotice(
        `Wallet "${selectedId}" extension not detected. Install the extension to connect.`,
      );
      return;
    }
    const res = await connect(selectedId);
    if (res) {
      setMenuOpen(false);
    }
  };

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
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        <span className={styles.dot} />
        <span>{shortAddress}</span>
        <span className={styles.network}>(testnet)</span>
      </button>

      {menuOpen && (
        <div className={styles.menu} role="menu">
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
              <span className={styles.diagVal}>
                {formatStatusLabel(activeCapabilities?.availability ?? "available")}
              </span>
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
              <span className={styles.diagVal}>
                {activeCapabilities?.signingLimitations.canSignAuthEntry
                  ? "supported"
                  : "unsupported"}
              </span>
            </div>

            <div className={styles.diagRow}>
              <span className={styles.diagKey}>account events</span>
              <span className={styles.diagVal}>
                {activeCapabilities?.supportedAccountQueries.canListenAccountChange
                  ? "live sync"
                  : "static"}
              </span>
            </div>

            <div className={styles.diagRow}>
              <span className={styles.diagKey}>active lane</span>
              <span className={styles.diagVal}>{network.toLowerCase()}</span>
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

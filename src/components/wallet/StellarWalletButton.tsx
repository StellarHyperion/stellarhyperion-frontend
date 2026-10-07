"use client";

import { useEffect, useRef, useState } from "react";
import { useStellarWallet } from "../../wallets/stellar";
import styles from "./StellarWalletButton.module.css";

export function StellarWalletButton() {
  const { isConnected, isConnecting, shortAddress, address, network, connect, disconnect } =
    useStellarWallet();
  const [menuOpen, setMenuOpen] = useState(false);
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
      </button>
    );
  }

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
        <span className={styles.network}>({network.toLowerCase()})</span>
      </button>

      {menuOpen && (
        <div className={styles.menu} role="menu">
          <div className={styles.addressRow}>
            <span className={styles.addressLabel}>stellar account</span>
            <span className={styles.fullAddress}>{address}</span>
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
    </div>
  );
}

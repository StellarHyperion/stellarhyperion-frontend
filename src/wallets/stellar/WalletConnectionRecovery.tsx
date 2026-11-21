"use client";
import { useEffect, useRef } from "react";
import type { WalletConnectionGuidance } from "./sdk";
import styles from "./WalletPicker.module.css";

export function WalletConnectionRecovery({
  guidance,
  wallet,
  onRetry,
  onChoose,
}: {
  guidance: WalletConnectionGuidance;
  wallet: { name: string; url: string };
  onRetry: () => void;
  onChoose: () => void;
}) {
  const status = useRef<HTMLDivElement>(null);
  useEffect(() => status.current?.focus(), [guidance]);
  return (
    <div ref={status} role="alert" tabIndex={-1} className={styles.error}>
      <p>{guidance.message}</p>
      <p>{guidance.action}</p>
      <div className={styles.recoveryActions}>
        {guidance.install && (
          <a href={wallet.url} target="_blank" rel="noopener noreferrer">
            Open {wallet.name} website
          </a>
        )}
        <button type="button" onClick={onRetry}>
          Retry {wallet.name} connection
        </button>
        <button type="button" onClick={onChoose}>
          Choose another wallet
        </button>
      </div>
      <details className={styles.connectionDetails}>
        <summary>Connection details</summary>
        <p>
          Wallet: {wallet.name}. Network: Stellar Testnet. Category: {guidance.category}.
        </p>
      </details>
    </div>
  );
}

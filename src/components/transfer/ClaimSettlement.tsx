"use client";

import { useState, type ReactElement } from "react";
import styles from "./ClaimSettlement.module.css";

interface ParkedClaim {
  id: string;
  chain: string;
  token: string;
  amount: string;
  recipient: string;
  status: "parked" | "settling" | "settled";
  settledTxHash?: string;
}

const SAMPLE_CLAIM: ParkedClaim = {
  id: "1",
  chain: "Stellar Testnet",
  token: "USDC",
  amount: "997.0000000",
  recipient: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  status: "parked",
};

export function ClaimSettlement(): ReactElement {
  const [claimIdInput, setClaimIdInput] = useState<string>("1");
  const [currentClaim, setCurrentClaim] = useState<ParkedClaim | null>(SAMPLE_CLAIM);
  const [isSettling, setIsSettling] = useState<boolean>(false);

  const handleLookup = () => {
    if (claimIdInput.trim() === "1") {
      setCurrentClaim(SAMPLE_CLAIM);
    } else if (claimIdInput.trim()) {
      setCurrentClaim({
        id: claimIdInput.trim(),
        chain: "Stellar Testnet",
        token: "USDC",
        amount: "500.0000000",
        recipient: "GCHPVETUL5E4YKDLMRIBFUGFK4PMYOVKPFALVSYMP2QDYAVBA3ITQDAI",
        status: "parked",
      });
    } else {
      setCurrentClaim(null);
    }
  };

  const handleSettle = () => {
    if (!currentClaim) return;
    setIsSettling(true);
    setTimeout(() => {
      setCurrentClaim({
        ...currentClaim,
        status: "settled",
        settledTxHash: "0x89f41a0b5c12...33d2",
      });
      setIsSettling(false);
    }, 1000);
  };

  return (
    <section className={styles.panel} aria-label="Parked claim settlement interface">
      <div className={styles.titleRow}>
        <h2 className={styles.title}>Parked claim settlement</h2>
        <span className={styles.tag}>permissionless recovery</span>
      </div>

      <p className={styles.description}>
        When a cross-chain delivery lands but cannot be handed directly to the recipient (for
        example, a destination Stellar classic account without an active asset trustline), the
        router parks the funds safely. Anyone can settle a parked claim once the recipient condition
        is resolved.
      </p>

      <div className={styles.lookupForm}>
        <div className={styles.field}>
          <label htmlFor="claim-id-input" className={styles.label}>
            Claim identifier
          </label>
          <input
            id="claim-id-input"
            type="text"
            className={styles.input}
            value={claimIdInput}
            onChange={(e) => {
              setClaimIdInput(e.target.value);
            }}
            placeholder="e.g. 1"
          />
        </div>
        <button type="button" className={styles.searchBtn} onClick={handleLookup}>
          lookup claim
        </button>
      </div>

      {currentClaim && (
        <div className={styles.claimCard}>
          <div className={styles.claimGrid}>
            <div className={styles.claimItem}>
              <span className={styles.itemLabel}>claim id</span>
              <span className={styles.itemValue}>#{currentClaim.id}</span>
            </div>
            <div className={styles.claimItem}>
              <span className={styles.itemLabel}>destination chain</span>
              <span className={styles.itemValue}>{currentClaim.chain}</span>
            </div>
            <div className={styles.claimItem}>
              <span className={styles.itemLabel}>parked amount</span>
              <span className={styles.itemValue}>
                {currentClaim.amount} {currentClaim.token}
              </span>
            </div>
            <div className={styles.claimItem}>
              <span className={styles.itemLabel}>status</span>
              <span className={`${styles.itemValue} ${styles.itemStatus}`}>
                {currentClaim.status}
              </span>
            </div>
          </div>

          <div className={styles.claimItem}>
            <span className={styles.itemLabel}>target recipient</span>
            <span className={styles.itemValue}>{currentClaim.recipient}</span>
          </div>

          {currentClaim.status === "settled" ? (
            <div className={styles.settledBanner}>
              claim #{currentClaim.id} has been settled successfully on chain
            </div>
          ) : (
            <button
              type="button"
              className={styles.settleBtn}
              onClick={handleSettle}
              disabled={isSettling}
            >
              {isSettling ? "settling claim..." : "settle parked claim"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

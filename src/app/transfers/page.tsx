"use client";
import { useEffect, useRef, useState } from "react";
import { Column } from "../../components/chrome";
import { fetchTransfers, type FormattedTransfer } from "../../api";
import { TransferList } from "../../components/transfers";
import { errorMessage } from "../../contracts";
import { ActivityRequestGuard } from "../../lib/activity-request";
import { useStellarWallet } from "../../wallets";
import styles from "./page.module.css";
export default function TransfersPage() {
  const { address } = useStellarWallet();
  return <TransfersPageContent key={address ?? "public"} address={address} />;
}
function TransfersPageContent({ address }: { address?: string | null }) {
  const [transfers, setTransfers] = useState<readonly FormattedTransfer[]>([]);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestGuard = useRef(new ActivityRequestGuard());
  useEffect(() => {
    const guard = requestGuard.current;
    const identityChanged = guard.setIdentity(address ?? null);
    if (identityChanged) {
      setTransfers([]);
      setError(null);
      setLoading(true);
    }
    guard.invalidate();
    const load = async () => {
      const token = guard.begin();
      try {
        const response = await fetchTransfers({
          ...(address ? { sender: address } : {}),
          search,
          limit: "20",
          offset: String(offset),
        });
        if (guard.isCurrent(token)) {
          setTransfers(response.transfers);
          setError(null);
        }
      } catch (cause) {
        if (guard.isCurrent(token)) {
          setError(errorMessage(cause));
        }
      } finally {
        if (guard.isCurrent(token)) setLoading(false);
      }
    };
    const delay = setTimeout(() => {
      setLoading(true);
      void load();
    }, 300);
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      guard.invalidate();
      clearTimeout(delay);
      clearInterval(timer);
    };
  }, [address, offset, search]);
  return (
    <Column>
      <h1 className="display">Transfer history</h1>
      <p className="lede">
        {address
          ? "Transfers sent by your connected Stellar account."
          : "Recent transfers observed by the indexer. Connect a Stellar wallet to see your transfers."}
      </p>
      <p className={styles.claimNote}>
        Claim numbers appear when a destination router holds funds for recovery. Delivered transfers
        need no claim recovery. Open transfer details to check a claim and its status.
      </p>
      <input
        className={styles.searchInput}
        aria-label="Search indexed transfers"
        placeholder="Transaction, recipient or nonce"
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setOffset(0);
        }}
      />
      {error && <p role="alert">{error}</p>}
      {loading && transfers.length === 0 ? (
        <p role="status">Loading indexed transfers...</p>
      ) : (
        <TransferList transfers={transfers} />
      )}
      <div className={styles.filterControls}>
        <button
          type="button"
          disabled={offset === 0 || loading}
          onClick={() => {
            setOffset((value) => Math.max(0, value - 20));
          }}
        >
          Previous
        </button>
        <span>Page {offset / 20 + 1}</span>
        <button
          type="button"
          disabled={transfers.length < 20 || loading}
          onClick={() => {
            setOffset((value) => value + 20);
          }}
        >
          Next
        </button>
      </div>
    </Column>
  );
}

"use client";
import { useEffect, useState } from "react";
import { Column, Footer, Header, Main, Shell } from "../../components/chrome";
import { fetchTransfers, type FormattedTransfer } from "../../api";
import { TransferList } from "../../components/transfers";
import { errorMessage } from "../../contracts";
import { useStellarWallet } from "../../wallets";
import styles from "./page.module.css";
export default function TransfersPage() {
  const { address } = useStellarWallet();
  const [transfers, setTransfers] = useState<readonly FormattedTransfer[]>([]);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetchTransfers({
          ...(address ? { sender: address } : {}),
          search,
          limit: "20",
          offset: String(offset),
        });
        if (active) {
          setTransfers(response.transfers);
          setError(null);
        }
      } catch (cause) {
        if (active) {
          setError(errorMessage(cause));
          setTransfers([]);
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    const delay = setTimeout(() => {
      setLoading(true);
      void load();
    }, 300);
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      active = false;
      clearTimeout(delay);
      clearInterval(timer);
    };
  }, [address, search, offset]);
  return (
    <Shell>
      <Header network="Stellar Testnet" />
      <Main>
        <Column>
          <h1 className="display">Transfer history</h1>
          <p className="lede">
            {address
              ? "Transfers sent by your connected Stellar account."
              : "Recent transfers observed by the indexer. Connect a Stellar wallet to see your transfers."}
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
          {error ? (
            <p role="alert">{error}</p>
          ) : loading ? (
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
      </Main>
      <Footer />
    </Shell>
  );
}

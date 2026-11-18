"use client";
import { useEffect, useState } from "react";
import { Column } from "../../components/chrome";
import {
  fetchIndexerMetrics,
  fetchTransfers,
  cursorFreshness,
  type FormattedTransfer,
  type IndexerMetrics,
  type TransfersResponse,
} from "../../api";
import { TransferList } from "../../components/transfers";
import { errorMessage } from "../../contracts";
import { useStellarWallet } from "../../wallets";
import styles from "./page.module.css";

function ActivityCoverage({
  response,
  metrics,
  metricsError,
}: {
  response: TransfersResponse | null;
  metrics: IndexerMetrics | null;
  metricsError: string | null;
}) {
  const cursor = metrics?.cursors.find((value) => value.chain === "stellar-testnet") ?? null;
  const freshness = cursorFreshness(cursor);
  const coverage = response?.coverage;

  return (
    <section
      className={styles.indexerStatus}
      aria-label="Indexer freshness and historical coverage"
    >
      <h2>Indexer coverage</h2>
      {metricsError ? (
        <p role="status">
          Indexer freshness is unavailable. The transfer result below is unchanged.
        </p>
      ) : cursor ? (
        <p role="status">
          Cursor {freshness}: Stellar Testnet ledger {cursor.block}, updated{" "}
          {new Date(cursor.updatedAt).toLocaleString()}.
        </p>
      ) : (
        <p role="status">
          Indexer freshness is unavailable: no Stellar Testnet cursor was reported.
        </p>
      )}
      {coverage?.complete === true ? (
        <p>
          Historical coverage is complete through{" "}
          {coverage.newestObservedAt ?? "the latest indexed record"}.
        </p>
      ) : coverage ? (
        <p>
          Historical coverage is incomplete
          {coverage.oldestObservedAt ? ` from ${coverage.oldestObservedAt}` : ""}.
          {coverage.reason ? ` ${coverage.reason}` : " Older records may be missing."}
        </p>
      ) : (
        <p>Historical coverage metadata is unavailable from this indexer contract.</p>
      )}
    </section>
  );
}

export default function TransfersPage() {
  const { address } = useStellarWallet();
  const [transfers, setTransfers] = useState<readonly FormattedTransfer[]>([]);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<IndexerMetrics | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [response, setResponse] = useState<TransfersResponse | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [historyResult, metricsResult] = await Promise.allSettled([
          fetchTransfers({
            ...(address ? { sender: address } : {}),
            search,
            limit: "20",
            offset: String(offset),
          }),
          fetchIndexerMetrics(),
        ]);
        if (!active) return;
        if (historyResult.status === "fulfilled") {
          setResponse(historyResult.value);
          setTransfers(historyResult.value.transfers);
          setError(null);
        } else {
          setResponse(null);
          setError(errorMessage(historyResult.reason));
          setTransfers([]);
        }
        if (metricsResult.status === "fulfilled") {
          setMetrics(metricsResult.value);
          setMetricsError(null);
        } else {
          setMetrics(null);
          setMetricsError(errorMessage(metricsResult.reason));
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
      {(response || metricsError) && (
        <ActivityCoverage response={response} metrics={metrics} metricsError={metricsError} />
      )}
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
  );
}

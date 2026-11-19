"use client";
import { useEffect, useRef, useState } from "react";
import { Column } from "../../components/chrome";
import {
  fetchIndexerMetrics,
  fetchTransfers,
  cursorFreshness,
  type IndexerMetrics,
  type TransfersResponse,
} from "../../api";
import { TransferList } from "../../components/transfers";
import { errorMessage } from "../../contracts";
import { ActivityRequestGuard } from "../../lib/activity-request";
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
  return <TransfersPageContent key={address ?? "public"} address={address} />;
}

function mergeTransfers(
  current: TransfersResponse["transfers"],
  incoming: TransfersResponse["transfers"],
) {
  const merged = new Map(current.map((transfer) => [transfer.id, transfer]));
  for (const transfer of incoming) merged.set(transfer.id, transfer);
  return [...merged.values()];
}

function TransfersPageContent({ address }: { address?: string | null }) {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([]);
  const [loadedTransfers, setLoadedTransfers] = useState<TransfersResponse["transfers"]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const scope = JSON.stringify([address ?? null, search, cursor, offset]);
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    response: TransfersResponse | null;
    metrics: IndexerMetrics | null;
    metricsError: string | null;
    error: string | null;
  } | null>(null);
  const current = snapshot?.scope === scope ? snapshot : null;
  const response = current?.response ?? null;
  const transfers = loadedTransfers;
  const metrics = current?.metrics ?? null;
  const metricsError = current?.metricsError ?? null;
  const error = current?.error ?? null;
  const pending = loading || current === null;
  const requestGuard = useRef(new ActivityRequestGuard());
  useEffect(() => {
    const guard = requestGuard.current;
    guard.setIdentity(address ?? null);
    guard.invalidate();
    const load = async () => {
      const token = guard.begin();
      try {
        const [historyResult, metricsResult] = await Promise.allSettled([
          fetchTransfers({
            ...(address ? { sender: address } : {}),
            search,
            limit: "20",
            ...(cursor ? { cursor } : { offset: String(offset) }),
          }),
          fetchIndexerMetrics(),
        ]);
        if (!guard.isCurrent(token)) return;
        setSnapshot({
          scope,
          response: historyResult.status === "fulfilled" ? historyResult.value : null,
          error: historyResult.status === "rejected" ? errorMessage(historyResult.reason) : null,
          metrics: metricsResult.status === "fulfilled" ? metricsResult.value : null,
          metricsError:
            metricsResult.status === "rejected" ? errorMessage(metricsResult.reason) : null,
        });
        if (historyResult.status === "fulfilled") {
          setLoadedTransfers((existing) => mergeTransfers(existing, historyResult.value.transfers));
          const next = historyResult.value.nextCursor ?? null;
          setHasMore(
            (historyResult.value.hasMore ?? Boolean(next)) ||
              historyResult.value.transfers.length >= historyResult.value.limit,
          );
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
  }, [address, cursor, offset, search, scope]);
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
      {(response !== null || metricsError !== null) && (
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
          setCursor(null);
          setCursorHistory([]);
          setLoadedTransfers([]);
          setHasMore(true);
          setSnapshot(null);
        }}
      />
      {error && <p role="alert">{error}</p>}
      {pending && transfers.length === 0 ? (
        <p role="status">Loading indexed transfers...</p>
      ) : (
        <TransferList transfers={transfers} />
      )}
      <div className={styles.filterControls}>
        <button
          type="button"
          disabled={pending || (cursor === null && offset === 0 && cursorHistory.length === 0)}
          onClick={() => {
            if (cursorHistory.length > 0) {
              setCursorHistory((history) => history.slice(0, -1));
              setCursor(cursorHistory[cursorHistory.length - 1] ?? null);
            } else {
              setOffset((value) => Math.max(0, value - 20));
            }
          }}
        >
          Previous
        </button>
        <span>{cursor !== null ? "Keyset page" : `Page ${offset / 20 + 1}`}</span>
        <button
          type="button"
          disabled={!hasMore || pending}
          onClick={() => {
            if (response?.nextCursor) {
              setCursorHistory((history) => [...history, cursor]);
              setCursor(response.nextCursor);
            } else {
              setOffset((value) => value + 20);
            }
          }}
        >
          Next
        </button>
      </div>
    </Column>
  );
}

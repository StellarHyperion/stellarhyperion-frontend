"use client";
import { startTransition, useEffect, useRef, useState } from "react";
import { Column } from "../../components/chrome";
import {
  fetchIndexerMetrics,
  fetchTransfers,
  cursorFreshness,
  filterTransfers,
  type IndexerMetrics,
  type TransfersResponse,
} from "../../api";
import { TransferList } from "../../components/transfers";
import { errorMessage } from "../../contracts";
import { useVisibilityPoll } from "../../lib/visibility-poll";
import { ActivityRequestGuard } from "../../lib/activity-request";
import { useStellarWallet } from "../../wallets";
import styles from "./page.module.css";
import {
  readTransferFilters,
  validateTransferFilters,
  filterSupportError,
} from "../../lib/transfer-filters";

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
function TransfersPageContent({ address }: { address?: string | null }) {
  const [search, setSearch] = useState("");
  const [asset, setAsset] = useState("");
  const [deployment, setDeployment] = useState("");
  const [offset, setOffset] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([]);
  const [ready, setReady] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const scope = JSON.stringify([address ?? null, search, offset, cursor, retry]);
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    response: TransfersResponse | null;
    metrics: IndexerMetrics | null;
    metricsError: string | null;
    error: string | null;
  } | null>(null);
  const current = snapshot?.scope === scope ? snapshot : null;
  const response = current?.response ?? null;
  const validated = validateTransferFilters({ asset, deployment });
  const filterError =
    urlError ?? validated.error ?? filterSupportError(response?.transfers ?? [], validated.filters);
  const transfers = filterError
    ? []
    : filterTransfers(response?.transfers ?? [], validated.filters);
  const metrics = current?.metrics ?? null;
  const metricsError = current?.metricsError ?? null;
  const error = current?.error ?? null;
  const requestGuard = useRef(new ActivityRequestGuard());
  useEffect(() => {
    const readUrl = () => {
      const result = readTransferFilters(window.location.search);
      startTransition(() => {
        setAsset(result.filters.asset ?? "");
        setDeployment(result.filters.deployment ?? "");
        setUrlError(result.error);
        setOffset(0);
        setCursor(null);
        setCursorHistory([]);
        setReady(true);
      });
    };
    readUrl();
    window.addEventListener("popstate", readUrl);
    return () => {
      window.removeEventListener("popstate", readUrl);
    };
  }, []);
  useEffect(() => {
    const guard = requestGuard.current;
    guard.setIdentity(scope);
    guard.invalidate();
    return () => {
      guard.invalidate();
    };
  }, [scope]);
  const refreshing = useVisibilityPoll(
    async (signal) => {
      if (!ready) return;
      const guard = requestGuard.current;
      const token = guard.begin();
      setLoading(true);
      try {
        const [historyResult, metricsResult] = await Promise.allSettled([
          fetchTransfers(
            {
              ...(address ? { sender: address } : {}),
              search,
              limit: "20",
              ...(cursor ? { cursor } : { offset: String(offset) }),
            },
            signal,
          ),
          fetchIndexerMetrics(signal),
        ]);
        if (signal.aborted || !guard.isCurrent(token)) return;
        setSnapshot({
          scope,
          response: historyResult.status === "fulfilled" ? historyResult.value : null,
          error: historyResult.status === "rejected" ? errorMessage(historyResult.reason) : null,
          metrics: metricsResult.status === "fulfilled" ? metricsResult.value : null,
          metricsError:
            metricsResult.status === "rejected" ? errorMessage(metricsResult.reason) : null,
        });
      } finally {
        if (!signal.aborted && guard.isCurrent(token)) setLoading(false);
      }
    },
    10_000,
    60_000,
    scope,
    300,
  );
  const pending = loading || refreshing || current === null;

  const updateFilter = (name: "asset" | "deployment", value: string) => {
    if (name === "asset") setAsset(value);
    else setDeployment(value);
    setUrlError(null);
    const result = validateTransferFilters({ asset, deployment, [name]: value });
    if (result.error) return;
    const params = new URLSearchParams(window.location.search);
    for (const key of ["asset", "deployment"] as const) {
      const identity = result.filters[key];
      if (identity) params.set(key, identity);
      else params.delete(key);
    }
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  };
  const clearFilters = () => {
    setAsset("");
    setDeployment("");
    setUrlError(null);
    const params = new URLSearchParams(window.location.search);
    params.delete("asset");
    params.delete("deployment");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  };
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
        }}
      />
      <div className={styles.identityFilters} role="group" aria-label="Transfer identity filters">
        <label>
          Asset identity
          <input
            className={styles.searchInput}
            aria-label="Filter by exact asset identity"
            placeholder="Issuer or token address"
            value={asset}
            onChange={(event) => {
              updateFilter("asset", event.target.value);
            }}
          />
        </label>
        <label>
          Deployment revision
          <input
            className={styles.searchInput}
            aria-label="Filter by deployment revision"
            placeholder="Router or revision"
            value={deployment}
            onChange={(event) => {
              updateFilter("deployment", event.target.value);
            }}
          />
        </label>
      </div>
      <p className={styles.claimNote}>
        Identity filters apply to the loaded page. Filtering the full history by token or revision
        is unavailable from this indexer. Continue through the pages to inspect more records.
      </p>
      {(asset || deployment || filterError) && (
        <button type="button" className={styles.readAction} onClick={clearFilters}>
          Clear identity filters
        </button>
      )}
      {filterError && <p role="alert">{filterError}</p>}
      {error && (
        <>
          <p role="alert">{error}</p>
          <button
            type="button"
            className={styles.readAction}
            onClick={() => {
              setRetry((value) => value + 1);
            }}
          >
            Retry history lookup
          </button>
        </>
      )}
      {!error && !filterError && response && (asset || deployment) && transfers.length === 0 && (
        <p role="alert">
          No record on this loaded page matches the selected identity. Later pages and incomplete
          history may contain more records.
        </p>
      )}
      {refreshing && transfers.length > 0 && (
        <p role="status">Refreshing indexed history before changing pages...</p>
      )}
      {filterError ? null : pending && transfers.length === 0 ? (
        <p role="status">Loading indexed transfers...</p>
      ) : (
        <TransferList transfers={transfers} />
      )}
      <div className={styles.filterControls}>
        <button
          type="button"
          disabled={(offset === 0 && cursorHistory.length === 0) || pending}
          onClick={() => {
            if (cursorHistory.length > 0) {
              setCursor(cursorHistory[cursorHistory.length - 1] ?? null);
              setCursorHistory((history) => history.slice(0, -1));
            } else {
              setOffset((value) => Math.max(0, value - 20));
            }
          }}
        >
          Previous
        </button>
        <span>Page {offset / 20 + cursorHistory.length + 1}</span>
        <button
          type="button"
          disabled={!(response?.hasMore ?? (response?.transfers.length ?? 0) >= 20) || pending}
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

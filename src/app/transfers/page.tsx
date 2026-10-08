"use client";

import { useEffect, useState, useMemo, type ReactElement } from "react";
import { Column, Footer, Header, Main, Shell } from "../../components/chrome";
import { fetchTransfers, type FormattedTransfer } from "../../api";
import { TransferList } from "../../components/transfers";
import styles from "./page.module.css";

export default function TransfersPage(): ReactElement {
  const [transfers, setTransfers] = useState<readonly FormattedTransfer[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [search, setSearch] = useState<string>("");
  const [chainFilter, setChainFilter] = useState<string>("all");
  const [stageFilter, setStageFilter] = useState<string>("all");
  const [routeFilter, setRouteFilter] = useState<string>("all");

  useEffect(() => {
    let mounted = true;
    void fetchTransfers().then((res) => {
      if (mounted) {
        setTransfers(res.transfers);
        setLoading(false);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  const filteredTransfers = useMemo(() => {
    return transfers.filter((t) => {
      if (chainFilter !== "all") {
        if (t.origin.chain !== chainFilter && t.destination.chain !== chainFilter) {
          return false;
        }
      }
      if (stageFilter !== "all" && t.stage !== stageFilter) {
        return false;
      }
      if (routeFilter !== "all" && String(t.route) !== routeFilter) {
        return false;
      }
      if (search.trim()) {
        const q = search.toLowerCase();
        const matchesOriginTx = t.origin.txHash.toLowerCase().includes(q);
        const matchesDestTx = t.destination.txHash?.toLowerCase().includes(q) ?? false;
        const matchesSender = t.origin.sender.toLowerCase().includes(q);
        const matchesRecipient = t.destination.recipient.toLowerCase().includes(q);
        const matchesNonce = t.origin.nonce === q;
        if (
          !matchesOriginTx &&
          !matchesDestTx &&
          !matchesSender &&
          !matchesRecipient &&
          !matchesNonce
        ) {
          return false;
        }
      }
      return true;
    });
  }, [transfers, chainFilter, stageFilter, routeFilter, search]);

  const stats = useMemo(() => {
    const total = transfers.length;
    const delivered = transfers.filter(
      (t) => t.stage === "delivered" || t.stage === "settled",
    ).length;
    const inFlight = transfers.filter(
      (t) =>
        t.stage === "initiated" ||
        t.stage === "attesting" ||
        t.stage === "attested" ||
        t.stage === "delivering",
    ).length;
    const parked = transfers.filter((t) => t.stage === "parked").length;
    return { total, delivered, inFlight, parked };
  }, [transfers]);

  return (
    <Shell>
      <Header network="stellar testnet" />
      <Main>
        <Column>
          <div className={styles.headingGroup}>
            <h1 className="display">Transfer registry</h1>
            <p className={`lede ${styles.intro}`}>
              Audit cross-chain message state, verify attestation progression across rails, and
              inspect settlement records on destination chains.
            </p>
          </div>

          <div className={styles.metricsGrid} aria-label="Transfer status summary">
            <div className={styles.metricCard}>
              <span className={styles.metricLabel}>Total indexed</span>
              <span className={styles.metricValue}>{stats.total}</span>
            </div>
            <div className={styles.metricCard}>
              <span className={styles.metricLabel}>Delivered</span>
              <span className={styles.metricValue}>{stats.delivered}</span>
            </div>
            <div className={styles.metricCard}>
              <span className={styles.metricLabel}>In transit</span>
              <span className={styles.metricValue}>{stats.inFlight}</span>
            </div>
            <div className={styles.metricCard}>
              <span className={styles.metricLabel}>Parked claims</span>
              <span className={styles.metricValue}>{stats.parked}</span>
            </div>
          </div>

          <div className={styles.filterBar}>
            <input
              type="text"
              className={styles.searchInput}
              placeholder="Filter by transaction hash, account address, or nonce..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
              }}
              aria-label="Filter transfers"
            />

            <div className={styles.filterControls}>
              <select
                className={styles.selectControl}
                value={chainFilter}
                onChange={(e) => {
                  setChainFilter(e.target.value);
                }}
                aria-label="Filter by chain"
              >
                <option value="all">All chains</option>
                <option value="stellar-testnet">Stellar Testnet</option>
                <option value="arc-testnet">Arc Testnet</option>
                <option value="arbitrum-sepolia">Arbitrum Sepolia</option>
                <option value="base-sepolia">Base Sepolia</option>
                <option value="ethereum-sepolia">Ethereum Sepolia</option>
              </select>

              <select
                className={styles.selectControl}
                value={routeFilter}
                onChange={(e) => {
                  setRouteFilter(e.target.value);
                }}
                aria-label="Filter by rail"
              >
                <option value="all">All rails</option>
                <option value="0">CCTP</option>
                <option value="1">Axelar ITS</option>
                <option value="2">Axelar GMP</option>
                <option value="3">Allbridge</option>
              </select>

              <select
                className={styles.selectControl}
                value={stageFilter}
                onChange={(e) => {
                  setStageFilter(e.target.value);
                }}
                aria-label="Filter by lifecycle stage"
              >
                <option value="all">All stages</option>
                <option value="delivered">Delivered</option>
                <option value="settled">Settled</option>
                <option value="attesting">Attesting</option>
                <option value="delivering">Delivering</option>
                <option value="parked">Parked</option>
                <option value="failed">Failed</option>
              </select>
            </div>
          </div>

          {loading ? (
            <div className={styles.emptyState}>Loading transfer records...</div>
          ) : (
            <TransferList transfers={filteredTransfers} />
          )}
        </Column>
      </Main>
      <Footer />
    </Shell>
  );
}

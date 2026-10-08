"use client";

import Link from "next/link";
import { type ReactElement } from "react";
import { ExternalLink } from "lucide-react";
import { getRouteName, type FormattedTransfer, type TransferLifecycleStage } from "../../api";
import { getExplorerUrl, shortenAddress, shortenTxHash } from "../../lib/format";
import styles from "./TransferList.module.css";

interface TransferListProps {
  readonly transfers: readonly FormattedTransfer[];
}

function getStageClass(stage: TransferLifecycleStage): string {
  switch (stage) {
    case "delivered":
    case "settled":
      return styles.stageDelivered ?? "";
    case "initiated":
    case "attesting":
    case "attested":
    case "delivering":
      return styles.stageInFlight ?? "";
    case "parked":
      return styles.stageParked ?? "";
    case "failed":
      return styles.stageFailed ?? "";
  }
}

export function TransferList({ transfers }: TransferListProps): ReactElement {
  if (transfers.length === 0) {
    return <div className={styles.emptyState}>No transfers matched the selected filters.</div>;
  }

  return (
    <div className={styles.transferList} role="feed" aria-label="Transfers list">
      {transfers.map((t) => (
        <Link
          key={t.id}
          href={`/transfers/${encodeURIComponent(t.origin.txHash)}`}
          className={styles.transferCard}
        >
          <div className={styles.cardTop}>
            <div className={styles.routeAndStage}>
              <span className={styles.routeBadge}>{getRouteName(t.route)}</span>
              <span className={`${styles.stageBadge} ${getStageClass(t.stage)}`}>{t.stage}</span>
            </div>
            <time className={styles.timestamp} dateTime={t.origin.observedAt}>
              {new Date(t.origin.observedAt).toLocaleString()}
            </time>
          </div>

          <div className={styles.cardBody}>
            <div className={styles.legBlock}>
              <span className={styles.legLabel}>origin</span>
              <span className={styles.chainName}>{t.origin.chain}</span>
              <span className={styles.addressMono}>
                <span>from {shortenAddress(t.origin.sender)}</span>
                <a
                  href={getExplorerUrl(t.origin.chain, "address", t.origin.sender)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`View sender address ${t.origin.sender} on ${t.origin.chain} explorer`}
                  className={styles.explorerLink}
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                >
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
                <span>(tx: {shortenTxHash(t.origin.txHash)})</span>
                <a
                  href={getExplorerUrl(t.origin.chain, "tx", t.origin.txHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`View origin transaction ${t.origin.txHash} on ${t.origin.chain} explorer`}
                  className={styles.explorerLink}
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                >
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              </span>
            </div>

            <div className={styles.legBlock}>
              <span className={styles.legLabel}>destination</span>
              <span className={styles.chainName}>{t.destination.chain}</span>
              <span className={styles.addressMono}>
                <span>to {shortenAddress(t.destination.recipient)}</span>
                <a
                  href={getExplorerUrl(t.destination.chain, "address", t.destination.recipient)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`View recipient address ${t.destination.recipient} on ${t.destination.chain} explorer`}
                  className={styles.explorerLink}
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                >
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
                {t.destination.txHash && (
                  <>
                    <span>(tx: {shortenTxHash(t.destination.txHash)})</span>
                    <a
                      href={getExplorerUrl(t.destination.chain, "tx", t.destination.txHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`View destination transaction ${t.destination.txHash} on ${t.destination.chain} explorer`}
                      className={styles.explorerLink}
                      onClick={(e) => {
                        e.stopPropagation();
                      }}
                    >
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  </>
                )}
              </span>
            </div>
          </div>

          <div className={styles.cardBottom}>
            <div className={styles.amountGroup}>
              <span className={styles.netAmount}>{t.origin.netAmount} USDC</span>
              <span className={styles.feeAmount}>(fee: {t.origin.fee} USDC)</span>
            </div>
            <span className={styles.inspectAction}>inspect transfer details</span>
          </div>
        </Link>
      ))}
    </div>
  );
}

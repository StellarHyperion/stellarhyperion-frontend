"use client";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { Column } from "../../../components/chrome";
import { fetchTransferByTx, getRouteName, type FormattedTransfer } from "../../../api";
import { readTransaction, errorMessage, type TransactionResult } from "../../../contracts";
import { formatTokenAmount, getExplorerUrl } from "../../../lib/format";
import styles from "./page.module.css";
export default function TransferDetailPage({ params }: { params: Promise<{ txHash: string }> }) {
  const { txHash } = use(params);
  const [record, setRecord] = useState<FormattedTransfer | null>(null);
  const [origin, setOrigin] = useState<TransactionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [indexerError, setIndexerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const load = async () => {
      await Promise.allSettled([
        readTransaction(txHash)
          .then((result) => {
            if (active) {
              setOrigin(result);
              setError(null);
            }
          })
          .catch((cause: unknown) => {
            if (active) setError(errorMessage(cause));
          }),
        fetchTransferByTx(txHash)
          .then((result) => {
            if (active) {
              setRecord(result);
              setIndexerError(null);
            }
          })
          .catch((cause: unknown) => {
            if (active) setIndexerError(errorMessage(cause));
          }),
      ]);
      if (active) setLoading(false);
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [txHash]);
  return (
    <Column>
      <Link href="/transfers">Back to transfer history</Link>
      <h1 className="display">Transaction status</h1>
      <p className="mono" style={{ overflowWrap: "anywhere" }}>
        {txHash}
      </p>
      {loading && <p role="status">Checking chain and indexer...</p>}
      {error && <p role="alert">{error}</p>}
      {origin && (
        <section className={styles.legPanel} aria-label="Stellar transaction status">
          <h2>Stellar transaction</h2>
          <p role="status">
            {origin.status === "confirmed"
              ? "Confirmed on Stellar Testnet."
              : origin.status === "failed"
                ? "Failed on Stellar. No transfer was dispatched."
                : "Not yet confirmed by the RPC. Check this hash before submitting again."}
          </p>
          <a
            href={getExplorerUrl("stellar-testnet", "tx", txHash)}
            target="_blank"
            rel="noopener noreferrer"
          >
            View on Stellar Explorer
          </a>
        </section>
      )}
      {indexerError && (
        <p role="status">{indexerError} Destination delivery cannot be verified here.</p>
      )}
      {!loading && !record && !indexerError && (
        <p>
          The indexer has not recorded this transfer yet. Source confirmation alone does not verify
          destination delivery.
        </p>
      )}
      {record && (
        <section className={styles.legPanel} aria-label="Indexed transfer status">
          <h2>{getRouteName(record.route)}</h2>
          <p role="status">Status: {record.stage}</p>
          <p>
            Sent from {record.origin.chain} to {record.destination.chain}
          </p>
          <p>
            Bridged before relay fees:{" "}
            {formatTokenAmount(record.origin.netAmount, record.origin.decimals)}{" "}
            {record.origin.symbol ?? "token"}. Fee:{" "}
            {formatTokenAmount(record.origin.fee, record.origin.decimals)}{" "}
            {record.origin.symbol ?? "token"}.
          </p>
          {record.destination.delivered && record.destination.amount && (
            <p>
              Received: {formatTokenAmount(record.destination.amount, record.destination.decimals)}{" "}
              {record.destination.symbol ?? ""}.
            </p>
          )}
          <p style={{ overflowWrap: "anywhere" }}>Recipient: {record.destination.recipient}</p>
          {record.rail?.railStatus && <p>Rail reports: {record.rail.railStatus}</p>}
          {record.destination.txHash && (
            <a
              href={getExplorerUrl(record.destination.chain, "tx", record.destination.txHash)}
              target="_blank"
              rel="noopener noreferrer"
            >
              View destination transaction
            </a>
          )}
          {record.claim ? (
            <div aria-label="Claim recovery">
              <p>
                Claim number: <strong>{record.claim.id}</strong>
              </p>
              <p>
                {record.claim.settled
                  ? "Settled. Funds were paid to the recorded recipient."
                  : `Funds are parked on the ${record.destination.chain} router for the recorded recipient.`}
              </p>
              {!record.claim.settled && record.destination.chain === "stellar-testnet" && (
                <Link href="/#claim-recovery">Recover Stellar claim {record.claim.id}</Link>
              )}
            </div>
          ) : (
            <p>
              {record.destination.delivered
                ? "No recovery claim. This transfer was delivered to the destination wallet."
                : "No recovery claim has been recorded for this transfer. A pending transfer does not automatically create a claim."}
            </p>
          )}
        </section>
      )}
    </Column>
  );
}

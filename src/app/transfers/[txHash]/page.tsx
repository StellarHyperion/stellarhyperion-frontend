"use client";
import Link from "next/link";
import { use, useEffect, useRef, useState } from "react";
import { Column } from "../../../components/chrome";
import { fetchTransferByTx, getRouteName, type FormattedTransfer } from "../../../api";
import { readTransaction, errorMessage, type TransactionResult } from "../../../contracts";
import { STELLAR_DEPLOYMENT } from "../../../config/testnet";
import { formatTokenAmount, formatTokenIdentity, getExplorerUrl } from "../../../lib/format";
import { hasVerifiedDestinationEvidence, getEvidenceAwareStage } from "../../../lib/evidence";
import { EvidenceTimeline } from "../../../components/transfers/EvidenceTimeline";
import { useVisibilityPoll } from "../../../lib/visibility-poll";
import { ActivityRequestGuard } from "../../../lib/activity-request";
import styles from "./page.module.css";
export default function TransferDetailPage({ params }: { params: Promise<{ txHash: string }> }) {
  const { txHash } = use(params);
  if (!/^[0-9a-f]{64}$/i.test(txHash))
    return (
      <Column>
        <Link href="/transfers">Back to transfer history</Link>
        <h1 className="display">Invalid transaction hash</h1>
        <p role="alert">
          Enter a 64-character Stellar transaction hash. No chain or indexer lookup was made for
          this input.
        </p>
      </Column>
    );
  return <TransferDetailContent key={txHash.toLowerCase()} txHash={txHash.toLowerCase()} />;
}
function TransferDetailContent({ txHash }: { txHash: string }) {
  const [retry, setRetry] = useState(0);
  const [record, setRecord] = useState<FormattedTransfer | null>(null);
  const [origin, setOrigin] = useState<TransactionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [indexerError, setIndexerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [indexerFresh, setIndexerFresh] = useState(false);
  const requestGuard = useRef(new ActivityRequestGuard());
  useEffect(() => {
    const guard = requestGuard.current;
    guard.setIdentity(txHash);
    guard.invalidate();
    return () => {
      guard.invalidate();
    };
  }, [txHash]);
  const refreshing = useVisibilityPoll(
    async (signal) => {
      setIndexerFresh(false);
      const guard = requestGuard.current;
      const token = guard.begin();
      const current = () => !signal.aborted && guard.isCurrent(token);
      await Promise.allSettled([
        readTransaction(txHash, signal)
          .then((result) => {
            if (current()) {
              setOrigin(result);
              setError(null);
            }
          })
          .catch((cause: unknown) => {
            if (current()) setError(errorMessage(cause));
          }),
        fetchTransferByTx(txHash, signal)
          .then((result) => {
            if (current()) {
              setRecord(result);
              setIndexerError(null);
              setIndexerFresh(true);
            }
          })
          .catch((cause: unknown) => {
            if (current()) setIndexerError(errorMessage(cause));
          }),
      ]);
      if (current()) setLoading(false);
    },
    5_000,
    60_000,
    JSON.stringify([txHash, retry]),
    0,
  );

  return (
    <Column>
      <Link href="/transfers">Back to transfer history</Link>
      <h1 className="display">Transaction status</h1>
      <p className="mono" style={{ overflowWrap: "anywhere" }}>
        {txHash}
      </p>
      {(loading || refreshing) && <p role="status">Checking fresh chain and indexer status...</p>}
      {error && (
        <>
          <p role="alert">Source lookup is unavailable: {error}</p>
          <a
            href={getExplorerUrl("stellar-testnet", "tx", txHash)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Check the source on Stellar Explorer
          </a>
        </>
      )}
      {origin && (
        <section className={styles.legPanel} aria-label="Stellar transaction status">
          <h2>Stellar transaction</h2>
          <p role="status">
            {origin.status === "confirmed"
              ? "Confirmed on Stellar Testnet."
              : origin.status === "failed"
                ? "Failed on Stellar. No transfer was dispatched."
                : "Outcome unknown from the RPC. Check this hash before submitting again."}
          </p>
          {origin.reason && <p>{origin.reason}</p>}
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
      {!loading && (error !== null || indexerError !== null || !record) && (
        <button
          type="button"
          className={styles.readAction}
          onClick={() => {
            setLoading(true);
            setRetry((value) => value + 1);
          }}
        >
          Retry read-only status lookup
        </button>
      )}
      {!loading && !record && !indexerError && (
        <p>
          The indexer has not recorded this transfer yet. This is not proof that the source
          transaction is absent. Source confirmation alone does not verify destination delivery.
        </p>
      )}
      {record && (
        <section className={styles.legPanel} aria-label="Indexed transfer status">
          <h2>{getRouteName(record.route)}</h2>
          <p role="status">Status: {getEvidenceAwareStage(record)}</p>
          <EvidenceTimeline transfer={record} />
          <p>
            Sent from {record.origin.chain} to {record.destination.chain}
          </p>
          <p style={{ overflowWrap: "anywhere" }}>
            Destination token:{" "}
            {formatTokenIdentity(
              record.destination.token,
              record.destination.symbol,
              record.destination.decimals,
              record.destination.representation,
            )}
          </p>
          <p>
            Bridged before relay fees:{" "}
            {formatTokenAmount(record.origin.netAmount, record.origin.decimals)}{" "}
            {record.origin.symbol ?? "token"}. Fee:{" "}
            {formatTokenAmount(record.origin.fee, record.origin.decimals)}{" "}
            {record.origin.symbol ?? "token"}.
          </p>
          {hasVerifiedDestinationEvidence(record) && record.destination.amount && (
            <p>
              Actual received:{" "}
              {formatTokenAmount(record.destination.amount, record.destination.decimals)}{" "}
              {record.destination.symbol ?? "token"}. The source net and quote minimum are separate
              values.
            </p>
          )}
          <p style={{ overflowWrap: "anywhere" }}>Recipient: {record.destination.recipient}</p>
          {record.proofRevision && record.proofRevision.status !== "valid" && (
            <section aria-label="Proof revision notice">
              <p role="status">
                Destination evidence was {record.proofRevision.status}; this is a proof revision,
                not a second source transfer.
              </p>
              {record.proofRevision.previousTxHash && (
                <a
                  href={getExplorerUrl(
                    record.destination.chain,
                    "tx",
                    record.proofRevision.previousTxHash,
                  )}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Inspect original destination reference
                </a>
              )}
              {record.proofRevision.replacementTxHash && (
                <a
                  href={getExplorerUrl(
                    record.destination.chain,
                    "tx",
                    record.proofRevision.replacementTxHash,
                  )}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Inspect replacement destination reference
                </a>
              )}
              {record.proofRevision.reason && <p>{record.proofRevision.reason}</p>}
            </section>
          )}
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
                  ? "The indexer reports this claim as settled. The claim record is not re-read on chain here."
                  : `The indexer reports a claim on the ${record.destination.chain} router for the recorded recipient. Verify its current on-chain state before relying on this status.`}
              </p>
              {!record.claim.settled &&
                (indexerFresh &&
                !refreshing &&
                !indexerError &&
                record.claim.deployment?.chain === STELLAR_DEPLOYMENT.chain &&
                record.claim.deployment.router === STELLAR_DEPLOYMENT.router &&
                record.claim.deployment.revision === STELLAR_DEPLOYMENT.wasmHash ? (
                  <Link href="/#claim-recovery">Recover Stellar claim {record.claim.id}</Link>
                ) : (
                  <p>
                    This claim is read-only here because its chain, router, or deployment revision
                    is not supported by this app. Open it on the original verified deployment.
                  </p>
                ))}
            </div>
          ) : (
            <p>
              {hasVerifiedDestinationEvidence(record)
                ? "No recovery claim. This transfer was delivered to the destination wallet."
                : "No recovery claim has been recorded for this transfer. A pending transfer does not automatically create a claim."}
            </p>
          )}
        </section>
      )}
    </Column>
  );
}

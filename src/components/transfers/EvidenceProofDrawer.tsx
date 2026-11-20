"use client";
import { useEffect, useState } from "react";
import { fetchTransferEvidence, type FormattedTransfer } from "../../api/backend";
import { publicIdentifier, publicReference } from "../../lib/evidence";
import { PROOF_CHECKS, type ProofCheck, type TransferProof } from "../../lib/transfer-proof";
import styles from "./EvidenceTimeline.module.css";

export function EvidenceProofDrawer({ transfer }: { readonly transfer: FormattedTransfer }) {
  const [open, setOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const [proof, setProof] = useState<TransferProof | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open || transfer.route !== 1) return;
    const controller = new AbortController();
    // Schedule the read and its state transition together; a closed drawer performs no lookup.
    const timer = setTimeout(() => {
      setLoading(true);
      setFailed(false);
      setProof(null);
      void fetchTransferEvidence(transfer, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setProof(result);
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, transfer, retry]);
  const sourceHash = publicIdentifier(transfer.origin.txHash);
  const candidate = publicIdentifier(transfer.rail?.reference);
  const candidateHref = publicReference(transfer.rail?.reference);
  const references = proof
    ? [
        ["Message / command", proof.commandId],
        ["Execution receipt transaction", proof.executionHash],
        ["Receipt block number", proof.receiptBlock],
        ["Receipt block hash", proof.receiptBlockHash],
        ["Token mapping proof block", proof.mappingBlock],
        ["Token mapping block hash", proof.mappingBlockHash],
        ["Payment token", proof.token],
        ["Payment recipient", proof.recipient],
        ["Payment amount in token base units", proof.amount],
      ]
    : [];
  return (
    <details
      className={styles.proofDrawer}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary>Inspect public proof references</summary>
      <p>
        Source confirmation records a committed source transaction. Provider execution remains
        unverified until the destination receipt, canonical block, token mapping and exact payment
        checks pass.
      </p>
      <dl className={styles.references}>
        <div>
          <dt>Source transaction</dt>
          <dd>{sourceHash ?? "Public hash unavailable"}</dd>
        </div>
        <div>
          <dt>Source block / ledger</dt>
          <dd>
            {/^[0-9]{1,20}$/.test(transfer.origin.block) ? transfer.origin.block : "Unavailable"}
          </dd>
        </div>
        <div>
          <dt>Provider candidate, unverified</dt>
          <dd>
            {candidate ??
              (candidateHref ? (
                <a href={candidateHref} target="_blank" rel="noopener noreferrer">
                  View public provider reference
                </a>
              ) : (
                "No public message identifier recorded"
              ))}
          </dd>
        </div>
      </dl>
      {loading && <p role="status">Checking stored destination proof...</p>}
      {failed && (
        <>
          <p role="status">
            Detailed proof is unavailable. The destination checks remain unverified.
          </p>
          <button
            type="button"
            className={styles.proofRetry}
            onClick={() => {
              setRetry((value) => value + 1);
            }}
          >
            Retry proof lookup
          </button>
        </>
      )}
      {transfer.route !== 1 && (
        <p>
          Command and canonical receipt details are unavailable for this provider from the indexer.
          Use the source and destination explorer references to inspect the public transactions.
        </p>
      )}
      {proof && (
        <>
          <p role="status">
            {proof.status === "verified"
              ? "The recorded destination payment passes all stored proof checks."
              : "Candidate evidence is unverified. It does not establish destination payment."}
          </p>
          <dl className={styles.references}>
            {references.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value ?? "Unavailable"}</dd>
              </div>
            ))}
          </dl>
          <ul className={styles.proofChecks}>
            {(Object.keys(PROOF_CHECKS) as ProofCheck[]).map((key) => (
              <li key={key}>
                {proof.status === "verified" && proof.checks[key] ? "Passed" : "Unverified"}:{" "}
                {PROOF_CHECKS[key]}
              </li>
            ))}
          </ul>
          <p>
            Canonical receipt last rechecked:{" "}
            {proof.revalidatedAt
              ? new Date(proof.revalidatedAt).toLocaleString()
              : "No revalidation timestamp recorded"}
            . Stored proof describes the indexer&apos;s latest observation.
          </p>
        </>
      )}
    </details>
  );
}

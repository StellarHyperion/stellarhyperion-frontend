"use client";
import { useEffect, useRef, useState } from "react";
import {
  checkpointIdentity,
  importCheckpoint,
  getTransferCheckpoint,
  type TransferCheckpoint,
} from "../../contracts/checkpoint";
import {
  reconcileCheckpointImport,
  retainRecoveryAudit,
  type RecoveryAudit,
} from "../../lib/checkpoint-reconciliation";
import styles from "./Bridge.module.css";

export function CheckpointRecoveryInspector({ checkpoint }: { checkpoint: TransferCheckpoint }) {
  const [raw, setRaw] = useState("");
  const [audit, setAudit] = useState<{ identity: string; value: RecoveryAudit } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const request = useRef<AbortController | null>(null);
  const identity = checkpointIdentity(checkpoint) + ":" + String(checkpoint.revision ?? 0);
  useEffect(
    () => () => {
      request.current?.abort();
      request.current = null;
    },
    [identity],
  );
  const activeAudit = audit?.identity === identity ? audit.value : null;
  const check = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const active = () => {
      const saved = getTransferCheckpoint();
      return (
        !controller.signal.aborted &&
        saved &&
        checkpointIdentity(saved) + ":" + String(saved.revision ?? 0) === identity
      );
    };
    setChecking(true);
    setAudit(null);
    setError(null);
    try {
      const result = await reconcileCheckpointImport(raw, checkpoint, controller.signal);
      if (!active()) return;
      setAudit({ identity, value: result });
      try {
        await retainRecoveryAudit(result);
      } catch {
        if (active())
          setError(
            "The public audit could not be saved. Download this checked summary. Your pending checkpoint is unchanged.",
          );
      }
    } catch (cause) {
      if (active())
        setError(
          cause instanceof Error
            ? cause.message
            : "Recovery comparison failed. Your pending checkpoint is unchanged.",
        );
    } finally {
      if (request.current === controller) {
        request.current = null;
        setChecking(false);
      }
    }
  };
  return (
    <details className={styles.recoveryInspector}>
      <summary>Compare a recovery export</summary>
      <p id="recovery-import-help">
        Paste public recovery metadata to check every signed hash against Stellar Testnet. This read
        cannot sign, resubmit, or replace your saved transaction.
      </p>
      <label htmlFor="recovery-import">Recovery metadata</label>
      <textarea
        id="recovery-import"
        aria-describedby="recovery-import-help"
        maxLength={16384}
        value={raw}
        onChange={(event) => {
          request.current?.abort();
          request.current = null;
          setRaw(event.target.value);
          setChecking(false);
          setAudit(null);
          setError(null);
        }}
        rows={5}
      />
      <button
        type="button"
        className={styles.secondary}
        disabled={checking || !raw.trim()}
        onClick={() => {
          void check();
        }}
      >
        {checking ? "Checking both records..." : "Check recovery evidence"}
      </button>
      {checking && (
        <button
          type="button"
          className={styles.secondary}
          onClick={() => {
            request.current?.abort();
            request.current = null;
            setChecking(false);
          }}
        >
          Cancel comparison
        </button>
      )}
      {activeAudit && (
        <div role="status">
          <p>
            {activeAudit.unresolved
              ? "At least one signed hash remains unresolved. Preserve both records and retry their reads."
              : "Every source outcome was independently checked. The signed hashes remain separate; destination delivery is tracked separately."}
          </p>
          <p>
            Checked {activeAudit.checkedAt}. Comparison: {activeAudit.comparison}.
          </p>
          {activeAudit.records.map((record, index) => (
            <p key={index}>
              Record {index + 1}: {importCheckpoint(record.metadata)?.txHash} ({record.status},{" "}
              {record.source}).
            </p>
          ))}
          <a
            className={styles.transactionLink}
            download="hyperion-recovery-audit.json"
            href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(activeAudit))}`}
          >
            Download public audit
          </a>
        </div>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </details>
  );
}

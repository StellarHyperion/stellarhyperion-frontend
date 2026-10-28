"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatUnits } from "@hyperion/protocol";
import { TESTNET } from "../../config/testnet";
import {
  errorMessage,
  getClaim,
  parseSendAmount,
  quoteTransfer,
  readBalance,
  readLane,
  submitBridgeOut,
  submitSettleClaim,
  validateRecipient,
  type LaneState,
  type LiveQuote,
  type PendingClaim,
  type TransactionPhase,
  type TransactionResult,
} from "../../contracts";
import { useStellarWallet } from "../../wallets";
import styles from "./Bridge.module.css";

export function Bridge() {
  const wallet = useStellarWallet();
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [lane, setLane] = useState<LaneState | null>(null);
  const [quoted, setQuoted] = useState<{ key: string; value: LiveQuote } | null>(null);
  const quoteKey = `${amount}:${recipient}`;
  const quote = quoted?.key === quoteKey && lane?.available ? quoted.value : null;
  const [accountBalance, setAccountBalance] = useState<{ account: string; value: bigint } | null>(
    null,
  );
  const balance = accountBalance?.account === wallet.address ? accountBalance.value : null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<TransactionPhase | null>(null);
  const [result, setResult] = useState<TransactionResult | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    const load = () => {
      void readLane("sepolia")
        .then((value) => {
          if (active) {
            setLane(value);
            setError(null);
          }
        })
        .catch((cause: unknown) => {
          if (active) {
            setLane(null);
            setError(errorMessage(cause));
          }
        });
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    let active = true;
    if (wallet.address)
      void readBalance(wallet.address)
        .then((value) => {
          if (active && wallet.address) setAccountBalance({ account: wallet.address, value });
        })
        .catch(() => {
          /* Execution will recheck the balance and report the error. */
        });
    return () => {
      active = false;
    };
  }, [wallet.address, result, refresh]);

  useEffect(() => {
    let active = true;
    if (!amount || !lane?.available) return;
    const timer = setTimeout(() => {
      try {
        const parsed = parseSendAmount(amount);
        validateRecipient(recipient);
        void quoteTransfer("sepolia", parsed)
          .then((value) => {
            if (active) {
              setQuoted({ key: quoteKey, value });
              setError(null);
            }
          })
          .catch((cause: unknown) => {
            if (active) setError(errorMessage(cause));
          });
      } catch (cause) {
        if (active) setError(errorMessage(cause));
      }
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [amount, recipient, lane, refresh, quoteKey]);

  const submit = async () => {
    if (!quote || !wallet.address || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const submitted = await submitBridgeOut(
        wallet.address,
        quote,
        recipient,
        wallet.signTransaction,
        (nextPhase, hash) => {
          setPhase(nextPhase);
          if (hash) setResult({ status: "pending", txHash: hash });
        },
      );
      setResult(submitted);
    } catch (cause) {
      setResult(null);
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      setPhase(null);
    }
  };

  return (
    <section className={styles.panel} aria-labelledby="bridge-heading">
      <div className={styles.heading}>
        <h2 id="bridge-heading">Send testnet USDC</h2>
        <span className="monoSm">Axelar ITS</span>
      </div>
      <p>
        Stellar Testnet to Ethereum Sepolia. Receive the ITS representation of Stellar USDC, not
        Circle&apos;s native Sepolia USDC.
      </p>
      <p className={styles.status} role="status">
        {lane
          ? lane.available
            ? `Lane ready. Checked at Stellar ledger ${lane.ledger}.`
            : lane.reason
          : error
            ? "Unable to verify the lane."
            : "Checking the deployed lane..."}
      </p>
      <button
        type="button"
        className={styles.secondary}
        onClick={() => {
          setRefresh((value) => value + 1);
        }}
        disabled={busy}
      >
        Refresh network state
      </button>
      <label htmlFor="send-amount">Amount in USDC</label>
      <input
        id="send-amount"
        inputMode="decimal"
        autoComplete="off"
        value={amount}
        placeholder="0.00"
        disabled={busy || result !== null}
        onChange={(event) => {
          setAmount(event.target.value);
        }}
      />
      {wallet.address && (
        <p className="monoSm">
          Balance: {balance === null ? "unavailable" : `${formatUnits(balance, 7)} USDC`}
        </p>
      )}
      <label htmlFor="recipient">Recipient on Ethereum Sepolia</label>
      <input
        id="recipient"
        autoComplete="off"
        spellCheck={false}
        value={recipient}
        placeholder="0x..."
        disabled={busy || result !== null}
        onChange={(event) => {
          setRecipient(event.target.value);
        }}
      />
      {quote && (
        <dl className={styles.summary}>
          <div>
            <dt>Wallet debit</dt>
            <dd>{formatUnits(quote.grossAmount, 7)} USDC</dd>
          </div>
          <div>
            <dt>Protocol fee</dt>
            <dd>{formatUnits(quote.fee, 7)} USDC</dd>
          </div>
          <div>
            <dt>ITS token amount</dt>
            <dd>{formatUnits(quote.destinationAmount, 7)} USDC</dd>
          </div>
          <div>
            <dt>Axelar relay gas</dt>
            <dd>{formatUnits(quote.relayGas, 7)} XLM</dd>
          </div>
          <div>
            <dt>Quote ledger</dt>
            <dd>{quote.ledger}</dd>
          </div>
        </dl>
      )}
      <p>
        Use test assets only. You need testnet XLM for Stellar fees. The quoted Axelar relay gas is
        paid with this transfer. Stellar network fees are added by your wallet. Source confirmation
        does not mean destination delivery.
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {wallet.error && (
        <p role="alert" className={styles.error}>
          {wallet.error}
        </p>
      )}
      {!wallet.isConnected ? (
        <button type="button" onClick={() => void wallet.connect()} disabled={wallet.isConnecting}>
          Connect Stellar wallet
        </button>
      ) : (
        !result && (
          <button
            type="button"
            disabled={
              !quote || busy || !lane?.available || balance === null || balance < quote.grossAmount
            }
            onClick={() => void submit()}
          >
            {busy ? `${phase ?? "preparing"}...` : "Review and sign in wallet"}
          </button>
        )
      )}
      {result && (
        <div role="status" className={styles.summary}>
          <p>
            {result.status === "confirmed"
              ? "Confirmed on Stellar. Destination delivery is pending verification."
              : result.status === "failed"
                ? "Failed on Stellar. No transfer was dispatched."
                : "Submission outcome pending. Check this transaction before sending again."}
          </p>
          <Link href={`/transfers/${result.txHash}`}>
            Track transaction {result.txHash.slice(0, 12)}...
          </Link>
          <a
            href={`https://stellar.expert/explorer/testnet/tx/${result.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Stellar transaction
          </a>
          {result.status !== "pending" && (
            <button
              type="button"
              className={styles.secondary}
              onClick={() => {
                setResult(null);
                setAmount("");
              }}
            >
              New transfer
            </button>
          )}
        </div>
      )}
      <details>
        <summary>Testnet contract</summary>
        <p className={styles.address}>{TESTNET.router}</p>
        <a
          href="https://laboratory.stellar.org/account/fund"
          target="_blank"
          rel="noopener noreferrer"
        >
          Fund a testnet account with XLM
        </a>
      </details>
    </section>
  );
}

export function ClaimRecovery() {
  const wallet = useStellarWallet();
  const [id, setId] = useState("");
  const [claim, setClaim] = useState<PendingClaim | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TransactionResult | null>(null);
  const lookup = async () => {
    setBusy(true);
    setError(null);
    setClaim(null);
    setResult(null);
    try {
      setClaim(await getClaim(BigInt(id)));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const settle = async () => {
    if (!claim || !wallet.address || busy) return;
    setBusy(true);
    setError(null);
    try {
      const transaction = await submitSettleClaim(wallet.address, claim.id, wallet.signTransaction);
      setResult(transaction);
      if (transaction.status === "confirmed") setClaim(await getClaim(claim.id));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={styles.panel} aria-labelledby="claims-heading">
      <h2 id="claims-heading">Recover a Stellar claim</h2>
      <p>
        Look up a claim on the deployed Stellar router. Settlement always pays its recorded
        recipient.
      </p>
      <label htmlFor="claim-id">Claim number</label>
      <input
        id="claim-id"
        inputMode="numeric"
        value={id}
        onChange={(event) => {
          setId(event.target.value);
          setClaim(null);
        }}
        disabled={busy}
      />
      <button type="button" disabled={!/^\d+$/.test(id) || busy} onClick={() => void lookup()}>
        {busy ? "Checking..." : "Look up claim"}
      </button>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {claim && (
        <>
          <p className={styles.address}>Recipient: {claim.recipient}</p>
          <p>
            Amount:{" "}
            {claim.token === TESTNET.token
              ? `${formatUnits(claim.amount, 7)} USDC`
              : `${claim.amount} base units of ${claim.token}`}
          </p>
          <p>Status: {claim.settled ? "settled on chain" : "parked"}</p>
          {!claim.settled && (
            <button
              type="button"
              disabled={!wallet.address || busy || result?.status === "pending"}
              onClick={() => void settle()}
            >
              Sign claim settlement
            </button>
          )}
          {!wallet.address && !claim.settled && (
            <p>Connect your Stellar wallet to pay the settlement network fee.</p>
          )}
        </>
      )}
      {result && (
        <Link href={`/transfers/${result.txHash}`}>
          {result.status === "confirmed"
            ? "Settlement confirmed"
            : result.status === "failed"
              ? "Settlement failed"
              : "Settlement pending"}
          : view transaction
        </Link>
      )}
    </section>
  );
}

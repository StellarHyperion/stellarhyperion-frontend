"use client";

import Link from "next/link";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { useEffect, useState } from "react";
import { formatUnits, parseUnits } from "@hyperion/protocol";
import {
  TESTNET,
  destinationFor,
  destinationDecimals,
  type BridgeRoute,
  type DestinationKey,
} from "../../config/testnet";
import {
  errorMessage,
  getClaim,
  quoteTransfer,
  readLane,
  readTransaction,
  submitBridgeOut,
  submitSettleClaim,
  validateRecipient,
  type LaneState,
  type LiveQuote,
  type PendingClaim,
  type TransactionPhase,
  type TransactionResult,
} from "../../contracts";
import {
  USDC,
  accountAssets,
  quoteTrade,
  submitConversion,
  type SourceAsset,
  type TradeQuote,
} from "../../contracts/assets";
import {
  saveCheckpoint,
  useTransferCheckpoint,
  type TransferCheckpoint,
} from "../../contracts/checkpoint";
import { useStellarWallet } from "../../wallets";
import { AssetIcon, DestinationPicker, ReviewDialog, SourceAssetPicker } from "./AssetPicker";
import styles from "./Bridge.module.css";

const provider = (route: number) => (route === 0 ? "Circle CCTP" : "Axelar ITS");
const receiveSymbol = (route: number) => (route === 0 ? "USDC" : "USDC (ITS)");

function QuoteDetails({ quote }: { quote: LiveQuote }) {
  return (
    <dl className={styles.summary}>
      <div>
        <dt>Bridge amount</dt>
        <dd>{formatUnits(quote.grossAmount, 7)} USDC</dd>
      </div>
      <div>
        <dt>Hyperion fee</dt>
        <dd>{formatUnits(quote.fee, 7)} USDC</dd>
      </div>
      <div>
        <dt>{quote.route === 0 ? "Circle forwarding budget" : "Axelar relay gas budget"}</dt>
        <dd>
          {formatUnits(quote.relayGas, 7)} {quote.route === 0 ? "USDC" : "XLM"}
        </dd>
      </div>
      <div>
        <dt>Minimum received</dt>
        <dd>
          {formatUnits(quote.destinationAmount, destinationDecimals(quote.route))}{" "}
          {receiveSymbol(quote.route)}
        </dd>
      </div>
    </dl>
  );
}

function PendingTransferCard({
  checkpoint,
  busy,
  latest,
  onReset,
}: {
  checkpoint: TransferCheckpoint;
  busy: boolean;
  latest: TransactionResult | null;
  onReset: () => void;
}) {
  const wallet = useStellarWallet();
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<TransactionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<LiveQuote | null>(null);
  const current =
    checked?.txHash === checkpoint.txHash
      ? checked
      : latest?.txHash === checkpoint.txHash
        ? latest
        : null;
  const sameAccount = wallet.address === checkpoint.account;
  const check = async () => {
    if (checking || busy) return;
    setChecking(true);
    setError(null);
    try {
      const result = await readTransaction(checkpoint.txHash);
      setChecked(result);
      if (result?.status === "confirmed" && checkpoint.stage === "conversion" && sameAccount)
        setReview(
          await quoteTransfer(
            checkpoint.destination,
            BigInt(checkpoint.bridgeAmount),
            checkpoint.route,
          ),
        );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setChecking(false);
    }
  };
  const continueBridge = async () => {
    if (!review || !sameAccount || checking) return;
    setChecking(true);
    setError(null);
    try {
      const result = await submitBridgeOut(
        checkpoint.account,
        review,
        checkpoint.recipient,
        wallet.signTransaction,
        (_phase, hash) => {
          if (hash) saveCheckpoint({ ...checkpoint, stage: "bridge", txHash: hash });
        },
      );
      setChecked(result);
      setReview(null);
    } catch (cause) {
      const message = errorMessage(cause);
      if (/network rejected|Nothing was accepted/.test(message)) saveCheckpoint(checkpoint);
      setError(message);
    } finally {
      setChecking(false);
    }
  };
  return (
    <section className={styles.pending} aria-label="Transfer recovery">
      <div className={styles.pendingTitle}>
        <ShieldCheck size={18} aria-hidden="true" />
        <h2>
          {current?.status === "failed"
            ? "Transaction failed on Stellar"
            : checkpoint.stage === "conversion"
              ? current?.status === "confirmed"
                ? "Conversion confirmed"
                : "Conversion submitted"
              : current?.status === "confirmed"
                ? "Transfer confirmed on Stellar"
                : "Transfer submitted"}
        </h2>
      </div>
      <p>
        {checkpoint.stage === "conversion"
          ? "Your conversion and bridge are separate transactions. Check the conversion before continuing with USDC."
          : "Follow destination delivery in your transfer activity. A Stellar confirmation starts the bridge journey."}
      </p>
      <a
        className={styles.transactionLink}
        href={`https://stellar.expert/explorer/testnet/tx/${checkpoint.txHash}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        {checkpoint.txHash.slice(0, 12)}...{checkpoint.txHash.slice(-8)}{" "}
        <ArrowUpRight size={14} aria-hidden="true" />
      </a>
      {checkpoint.stage === "bridge" && (
        <Link href={`/transfers/${checkpoint.txHash}`}>
          Track transfer <ArrowRight size={14} aria-hidden="true" />
        </Link>
      )}
      {!sameAccount && (
        <p>
          Reconnect {checkpoint.account.slice(0, 7)}...{checkpoint.account.slice(-7)} to continue
          this transfer.
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {current?.status === "failed" ||
      (checkpoint.stage === "bridge" && current?.status === "confirmed") ? (
        <button
          type="button"
          className={styles.secondary}
          onClick={onReset}
          disabled={busy || checking}
        >
          Start another transfer
        </button>
      ) : (
        <button
          type="button"
          className={styles.secondary}
          onClick={() => {
            void check();
          }}
          disabled={busy || checking}
        >
          {checking
            ? "Checking transaction..."
            : checkpoint.stage === "conversion" && sameAccount
              ? "Check and continue"
              : "Check status"}
        </button>
      )}
      {review && (
        <ReviewDialog
          onClose={() => {
            if (!checking) setReview(null);
          }}
        >
          <p className={styles.reviewNote}>
            Conversion confirmed. This step bridges the USDC already in your wallet.
          </p>
          <QuoteDetails quote={review} />
          <p className={styles.address}>Recipient: {checkpoint.recipient}</p>
          <button
            type="button"
            className={styles.primary}
            disabled={checking || !sameAccount}
            onClick={() => {
              void continueBridge();
            }}
          >
            {checking ? "Confirming in your wallet..." : "Bridge converted USDC"}
          </button>
          {error && <p role="alert">{error}</p>}
        </ReviewDialog>
      )}
    </section>
  );
}

export function Bridge() {
  const wallet = useStellarWallet();
  const checkpoint = useTransferCheckpoint();
  const [source, setSource] = useState<SourceAsset>(USDC);
  const [destination, setDestination] = useState<DestinationKey>("sepolia");
  const [route, setRoute] = useState<BridgeRoute>(1);
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [touched, setTouched] = useState(false);
  const [picker, setPicker] = useState<"source" | "destination" | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [laneState, setLaneState] = useState<{
    key: string;
    value: LaneState | null;
    error: string | null;
  } | null>(null);
  const [quoted, setQuoted] = useState<{
    key: string;
    value: TradeQuote | null;
    error: string | null;
  } | null>(null);
  const [accounts, setAccounts] = useState<{
    account: string;
    assets: SourceAsset[];
    error: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<TransactionPhase | null>(null);
  const [step, setStep] = useState<"conversion" | "bridge">("bridge");
  const [result, setResult] = useState<TransactionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const laneKey = `${destination}:${route}:${refresh}`;
  const lane = laneState?.key === laneKey ? laneState.value : null;
  const laneError = laneState?.key === laneKey ? laneState.error : null;
  const quoteKey = `${laneKey}:${source.id}:${amount}:${recipient}`;
  const quote = quoted?.key === quoteKey && lane?.available ? quoted.value : null;
  const quoteError = quoted?.key === quoteKey ? quoted.error : null;
  const balances = accounts?.account === wallet.address ? accounts.assets : [];
  const sourceBalance =
    accounts?.account === wallet.address && !accounts.error
      ? (balances.find((asset) => asset.id === source.id)?.balance ?? "0")
      : undefined;
  const locked = busy || checkpoint !== null;
  let inputError: string | null = null;
  let valid = false;
  if (amount.trim() && recipient.trim()) {
    try {
      const parsed = parseUnits(amount.trim(), 7);
      if (parsed <= 0n || parsed > (1n << 63n) - 1n)
        throw new Error("Enter a positive amount within Stellar's asset limit.");
      validateRecipient(recipient);
      valid = true;
    } catch (cause) {
      inputError = errorMessage(cause);
    }
  }
  const fetching =
    valid && !locked && !laneError && (!lane || (lane.available && quoted?.key !== quoteKey));
  const chain = destinationFor(destination);
  useEffect(() => {
    let active = true;
    const load = () => {
      void readLane(destination, route)
        .then((value) => {
          if (active) setLaneState({ key: laneKey, value, error: null });
        })
        .catch((cause: unknown) => {
          if (active) setLaneState({ key: laneKey, value: null, error: errorMessage(cause) });
        });
    };
    load();
    const timer = setInterval(load, 30000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [destination, route, laneKey]);
  useEffect(() => {
    if (!wallet.address) return;
    const account = wallet.address;
    const controller = new AbortController();
    void accountAssets(account, controller.signal)
      .then((assets) => {
        if (!controller.signal.aborted) setAccounts({ account, assets, error: null });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setAccounts({ account, assets: [], error: errorMessage(cause) });
      });
    return () => {
      controller.abort();
    };
  }, [wallet.address, result, refresh]);
  useEffect(() => {
    if (!valid || !lane?.available || locked) return;
    let active = true;
    const timer = setTimeout(() => {
      void quoteTrade(destination, source, amount, route)
        .then((value) => {
          if (active) setQuoted({ key: quoteKey, value, error: null });
        })
        .catch((cause: unknown) => {
          if (active) setQuoted({ key: quoteKey, value: null, error: errorMessage(cause) });
        });
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [valid, lane, locked, destination, source, amount, route, quoteKey]);
  const submit = async () => {
    if (!quote || !wallet.address || busy || checkpoint) return;
    setReviewing(false);
    setBusy(true);
    setError(null);
    setResult(null);
    setPhase("preparing");
    const sender = wallet.address;
    let converted: TransferCheckpoint | null = null;
    const pending = (stage: "conversion" | "bridge", hash: string): TransferCheckpoint => ({
      router: TESTNET.router,
      account: sender,
      recipient: validateRecipient(recipient),
      destination,
      route,
      bridgeAmount: String(quote.bridge.requestedAmount),
      stage,
      txHash: hash,
    });
    try {
      if (quote.conversion) {
        setStep("conversion");
        const swap = await submitConversion(
          wallet.address,
          quote.conversion,
          wallet.signTransaction,
          (next, hash) => {
            setPhase(next);
            if (hash) saveCheckpoint(pending("conversion", hash));
          },
        );
        if (swap.status !== "confirmed") {
          setResult(swap);
          if (swap.status === "failed")
            setError("The conversion failed. No bridge transaction was submitted.");
          return;
        }
        converted = pending("conversion", swap.txHash);
        saveCheckpoint(converted);
      }
      setStep("bridge");
      setPhase("preparing");
      const submitted = await submitBridgeOut(
        wallet.address,
        quote.bridge,
        recipient,
        wallet.signTransaction,
        (next, hash) => {
          setPhase(next);
          if (hash) {
            saveCheckpoint(pending("bridge", hash));
            setResult({ status: "pending", txHash: hash });
          }
        },
      );
      setResult(submitted);
    } catch (cause) {
      const message = errorMessage(cause);
      if (/network rejected|Nothing was accepted/.test(message)) saveCheckpoint(converted);
      setError(message);
    } finally {
      setBusy(false);
      setPhase(null);
    }
  };
  const reset = () => {
    saveCheckpoint(null);
    setResult(null);
    setError(null);
    setAmount("");
    setRefresh((value) => value + 1);
  };
  const insufficient =
    quote && sourceBalance !== undefined && parseUnits(sourceBalance, 7) < quote.sourceAmount;
  return (
    <>
      {checkpoint && (
        <PendingTransferCard checkpoint={checkpoint} busy={busy} latest={result} onReset={reset} />
      )}
      <section className={styles.panel} aria-labelledby="bridge-heading" aria-busy={fetching}>
        <div className={styles.heading}>
          <div>
            <h2 id="bridge-heading">Bridge assets</h2>
          </div>
          <button
            type="button"
            className={styles.refresh}
            aria-label="Refresh quote and networks"
            title="Refresh quote and networks"
            disabled={locked}
            onClick={() => {
              setRefresh((value) => value + 1);
            }}
          >
            <RefreshCw size={17} aria-hidden="true" />
          </button>
        </div>
        <div className={styles.assetPanel}>
          <div className={styles.fieldHeading}>
            <label htmlFor="send-amount">You send</label>
            <span>
              <span className={styles.chainDot} />
              Stellar Testnet
            </span>
          </div>
          <div className={styles.amountRow}>
            <input
              id="send-amount"
              aria-label="Amount to send"
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              placeholder="0.00"
              disabled={locked}
              onChange={(event) => {
                setAmount(event.target.value);
                setError(null);
              }}
            />
            <button
              type="button"
              className={styles.tokenSelector}
              aria-label="Choose source token"
              disabled={locked}
              onClick={() => {
                setPicker("source");
              }}
            >
              <AssetIcon code={source.code} />
              <span>{source.code}</span>
              <ChevronDown size={15} aria-hidden="true" />
            </button>
          </div>
          <p className={styles.balance}>
            {wallet.address
              ? sourceBalance !== undefined
                ? `Balance: ${sourceBalance} ${source.code}`
                : (accounts?.error ?? "Reading your balance...")
              : "Choose any liquid Stellar asset"}
          </p>
          {source.issuer && source.id !== USDC.id && (
            <a
              className={styles.balance}
              href={`https://stellar.expert/explorer/testnet/asset/${source.code}-${source.issuer}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Issuer: {source.issuer.slice(0, 7)}...{source.issuer.slice(-7)}
            </a>
          )}
        </div>
        <div className={styles.connector} aria-hidden="true">
          <ArrowDown size={18} />
        </div>
        <div className={`${styles.assetPanel} ${styles.receivePanel}`}>
          <div className={styles.fieldHeading}>
            <span>You receive{route === 0 ? " at least" : ""}</span>
            <button
              type="button"
              className={styles.networkSelector}
              aria-label="Choose destination network and token"
              disabled={locked}
              onClick={() => {
                setPicker("destination");
              }}
            >
              {chain.name}
              <ChevronDown size={13} aria-hidden="true" />
            </button>
          </div>
          <div className={styles.amountRow}>
            {fetching ? (
              <div className={styles.skeleton} aria-hidden="true" />
            ) : (
              <output aria-label="Minimum received" className={styles.receiveAmount}>
                {quote ? (
                  formatUnits(quote.bridge.destinationAmount, destinationDecimals(route))
                ) : (
                  <span className={styles.emptyAmount}>0.00</span>
                )}
              </output>
            )}
            <button
              type="button"
              className={styles.tokenSelector}
              aria-label="Choose receive token and bridge"
              disabled={locked}
              onClick={() => {
                setPicker("destination");
              }}
            >
              <AssetIcon code="USDC" />
              <span>USDC{route === 1 && <small>ITS</small>}</span>
              <ChevronDown size={15} aria-hidden="true" />
            </button>
          </div>
          <p className={styles.balance}>
            {route === 0
              ? "Native USDC. Automatic destination minting."
              : "ITS representation of Stellar USDC, not Circle's native USDC."}
          </p>
        </div>
        <div className={styles.recipientField}>
          <label htmlFor="recipient">
            <Wallet size={14} aria-hidden="true" /> Destination wallet
          </label>
          <input
            id="recipient"
            aria-label={`Recipient on ${chain.name}`}
            autoComplete="off"
            spellCheck={false}
            placeholder="0x..."
            value={recipient}
            disabled={locked}
            onBlur={() => {
              setTouched(true);
            }}
            onChange={(event) => {
              setRecipient(event.target.value);
              setError(null);
            }}
          />
        </div>
        {fetching ? (
          <div className={styles.fetching} role="status">
            <span className={styles.fetchOrbit} aria-hidden="true">
              <LoaderCircle size={22} />
            </span>
            <div>
              <strong>Finding your route</strong>
              <span>Checking liquidity, bridge fees and the receive amount</span>
            </div>
            <span className={styles.fetchDots} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </div>
        ) : quote ? (
          <details className={styles.routeDetails}>
            <summary>
              <span className={styles.routeIdentity}>
                <ShieldCheck size={16} aria-hidden="true" />
                {quote.conversion && (
                  <>
                    Stellar DEX <ArrowRight size={12} aria-hidden="true" />
                  </>
                )}
                {provider(route)}
              </span>
              <span>
                Fee details <ChevronDown size={13} aria-hidden="true" />
              </span>
            </summary>
            <QuoteDetails quote={quote.bridge} />
            {quote.conversion && (
              <p className={styles.assetNote}>
                Convert up to {formatUnits(quote.sourceAmount, 7)} {source.code} into{" "}
                {formatUnits(quote.bridge.requestedAmount, 7)} USDC, then bridge. Price tolerance:
                0.5%. Two wallet signatures. If bridging stops, USDC stays in your wallet.
              </p>
            )}
            <p className={styles.assetNote}>
              Quoted at Stellar ledger {quote.bridge.ledger}. Fees are checked again before signing.
            </p>
            <p className={styles.assetNote}>
              Relay budgets include 10% headroom. The Axelar XLM budget is paid in full; the Circle
              receive minimum accounts for its full USDC budget.
            </p>
          </details>
        ) : (
          !locked && (
            <p className={styles.quotePrompt}>
              {lane?.available
                ? "Enter an amount and destination wallet to find your route."
                : (lane?.reason ??
                  (laneError
                    ? "Network verification is unavailable. Refresh to try again."
                    : "Checking bridge availability..."))}
            </p>
          )
        )}
        {(error ?? wallet.error ?? quoteError ?? laneError ?? (touched && inputError)) && (
          <p role="alert" className={styles.error}>
            {error ?? wallet.error ?? quoteError ?? laneError ?? inputError}
          </p>
        )}
        {insufficient && (
          <p role="alert" className={styles.error}>
            Your {source.code} balance is lower than this amount.
          </p>
        )}
        {busy && (
          <p role="status" className={styles.progress}>
            <LoaderCircle className={styles.spinner} size={16} aria-hidden="true" />
            {step === "conversion" ? "Converting to USDC" : "Preparing your bridge"}:{" "}
            {phase === "signing"
              ? "confirm in your wallet"
              : phase === "submitting"
                ? "submitting the signed transaction"
                : phase === "pending"
                  ? "waiting for Stellar confirmation"
                  : "checking the current quote"}
            .
          </p>
        )}
        {!wallet.isConnected ? (
          <button
            type="button"
            className={styles.primary}
            onClick={() => {
              void wallet.connect();
            }}
            disabled={wallet.isConnecting}
          >
            <Wallet size={17} aria-hidden="true" />
            {wallet.isConnecting ? "Connecting wallet..." : "Connect Stellar wallet"}
            <ArrowUpRight size={18} aria-hidden="true" />
          </button>
        ) : (
          !checkpoint && (
            <button
              type="button"
              className={styles.primary}
              disabled={!quote || busy || !!insufficient || sourceBalance === undefined}
              onClick={() => {
                setReviewing(true);
              }}
            >
              {fetching ? "Finding your route..." : "Review transfer"}
              <ArrowRight size={18} aria-hidden="true" />
            </button>
          )
        )}
        <p className={styles.feeNote}>
          <ShieldCheck size={13} aria-hidden="true" />
          You stay in control. Your wallet signs every transaction.
        </p>
        <details className={styles.support}>
          <summary>
            New to testnet? Get started <ChevronDown size={14} aria-hidden="true" />
          </summary>
          <p>Use test assets only. Fund your wallet with XLM for network fees and relay gas.</p>
          <a
            href="https://laboratory.stellar.org/account/fund"
            target="_blank"
            rel="noopener noreferrer"
          >
            Get testnet XLM <ArrowUpRight size={13} aria-hidden="true" />
          </a>
          <a href="https://faucet.circle.com/" target="_blank" rel="noopener noreferrer">
            Get testnet USDC <ArrowUpRight size={13} aria-hidden="true" />
          </a>
          <p>
            Add the USDC trustline before using Circle&apos;s faucet. Conversion from another token
            can create the trustline with your signature.
          </p>
          <p className={styles.address}>USDC issuer: {TESTNET.usdcIssuer}</p>
          <p className={styles.address}>Router: {TESTNET.router}</p>
        </details>
      </section>
      {picker === "source" && (
        <SourceAssetPicker
          selected={source}
          balances={balances}
          onSelect={(asset) => {
            setSource(asset);
            setError(null);
          }}
          onClose={() => {
            setPicker(null);
          }}
        />
      )}
      {picker === "destination" && (
        <DestinationPicker
          destination={destination}
          route={route}
          onSelect={(next, bridge) => {
            setDestination(next);
            setRoute(bridge);
            setError(null);
          }}
          onClose={() => {
            setPicker(null);
          }}
        />
      )}
      {reviewing && quote && (
        <ReviewDialog
          onClose={() => {
            setReviewing(false);
          }}
        >
          <div className={styles.reviewTotal}>
            <span>You send {quote.conversion ? "up to" : ""}</span>
            <strong>
              {formatUnits(quote.sourceAmount, 7)} {source.code}
            </strong>
            <ArrowDown size={20} aria-hidden="true" />
            <span>You receive at least</span>
            <strong>
              {formatUnits(quote.bridge.destinationAmount, destinationDecimals(route))}{" "}
              {receiveSymbol(route)}
            </strong>
          </div>
          <p className={styles.reviewNote}>
            From Stellar Testnet to {chain.name} via {provider(route)}.
          </p>
          <p className={styles.address}>Recipient: {validateRecipient(recipient)}</p>
          {source.issuer && source.id !== USDC.id && (
            <p className={styles.address}>Source issuer: {source.issuer}</p>
          )}
          <QuoteDetails quote={quote.bridge} />
          {quote.conversion && (
            <p className={styles.reviewNote}>
              Two signatures: convert to USDC, then bridge. Price tolerance is 0.5%. If the bridge
              cannot proceed, your converted USDC remains in your wallet.
            </p>
          )}
          <p className={styles.reviewNote}>
            Source confirmation starts the transfer. Destination delivery is verified separately.
          </p>
          <button
            type="button"
            className={styles.primary}
            onClick={() => {
              void submit();
            }}
          >
            Confirm in wallet <ArrowUpRight size={17} aria-hidden="true" />
          </button>
        </ReviewDialog>
      )}
    </>
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
    <section
      id="claim-recovery"
      className={`${styles.panel} ${styles.recovery}`}
      aria-labelledby="claims-heading"
    >
      <details>
        <summary>
          <div>
            <h2 id="claims-heading">Recover a Stellar claim</h2>
            <span>For funds parked on the Stellar router</span>
          </div>
          <Plus size={18} aria-hidden="true" />
        </summary>
        <div className={styles.recoveryBody}>
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
        </div>
      </details>
    </section>
  );
}

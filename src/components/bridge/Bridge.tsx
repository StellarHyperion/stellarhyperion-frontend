"use client";

import Link from "next/link";
import {
  ArrowDown,
  ArrowRight,
  Copy,
  ArrowUpRight,
  ChevronDown,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatUnits, parseUnits } from "@hyperion/protocol";
import { fetchClaims } from "../../api";
import {
  TESTNET,
  destinationFor,
  destinationDecimals,
  type BridgeRoute,
  type DestinationKey,
} from "../../config/testnet";
import {
  errorMessage,
  batchClaimSettlementSupport,
  getClaims,
  quoteTransfer,
  TRANSACTION_TIMEOUT_SECONDS,
  quoteFreshness,
  readLane,
  readTransaction,
  simulateBridgeOut,
  submitBridgeOut,
  submitSettleClaim,
  submitSettleClaims,
  validateRecipient,
  quoteBreakdown,
  type LaneState,
  type LiveQuote,
  type PendingClaim,
  type SimulatedOperation,
  type SubmissionReconciliation,
  type TransactionPhase,
  type TransactionResult,
} from "../../contracts";
import {
  USDC,
  XLM,
  accountAssets,
  accountTrustlineReserve,
  issuerVerificationLabel,
  conversionExecutionIntent,
  conversionRoute,
  quoteTrade,
  spendableBalance,
  submitConversion,
  stellarAsset,
  trustlineLabel,
  trustlineReserveImpact,
  type Conversion,
  type SourceAsset,
  type TradeQuote,
  type TrustlineReservePreview,
} from "../../contracts/assets";
import { planMaxUsdcAmount, planMaxSourceAmount } from "../../lib/max-planner";
import {
  claimOperationOwnership,
  getOperationOwnership,
  releaseOperationOwnership,
  saveCheckpoint,
  assertCheckpointStorage,
  useTransferCheckpoint,
  type TransferCheckpoint,
} from "../../contracts/checkpoint";
import { useStellarWallet } from "../../wallets";
import type { WalletApprovalProvenance } from "../../wallets/stellar";
import { AssetIcon, DestinationPicker, ReviewDialog, SourceAssetPicker } from "./AssetPicker";
import styles from "./Bridge.module.css";

const provider = (route: number) => (route === 0 ? "Circle CCTP" : "Axelar ITS");
const receiveSymbol = (route: number) => (route === 0 ? "USDC" : "USDC (ITS)");

export interface BridgeFormParams {
  amount: string;
  recipient: string;
  destination: DestinationKey;
  route: BridgeRoute;
  source: SourceAsset;
}

// Bounded public form state: only these keys are part of a shareable bridge link.
// Checkpoints, signatures and submission intent are deliberately excluded.
export function parseBridgeFormParams(search: string): BridgeFormParams | null {
  if (search.length > 2048) return null;
  const params = new URLSearchParams(search);
  if (["a", "r", "d", "t", "s"].some((key) => params.getAll(key).length > 1)) return null;
  const amount = params.get("a") ?? "";
  const recipient = params.get("r") ?? "";
  const destinationRaw = params.get("d");
  const routeRaw = params.get("t");
  const sourceRaw = params.get("s");

  let destination: DestinationKey = "sepolia";
  if (destinationRaw) {
    try {
      destination = destinationFor(destinationRaw).key;
    } catch {
      return null;
    }
  }

  let route: BridgeRoute = 1;
  if (routeRaw) {
    if (routeRaw === "0") route = 0;
    else if (routeRaw === "1") route = 1;
    else return null;
  }

  if (amount.length > 64 || recipient.length > 42 || (sourceRaw?.length ?? 0) > 128) return null;
  if (amount) {
    try {
      if (!/^\d+(?:\.\d{1,7})?$/.test(amount)) return null;
      const value = parseUnits(amount, 7);
      if (value <= 0n || value > (1n << 63n) - 1n) return null;
    } catch {
      return null;
    }
  }
  if (recipient) {
    try {
      validateRecipient(recipient, destination);
    } catch {
      return null;
    }
  }
  if (!destinationFor(destination).routes.includes(route)) return null;
  let source: SourceAsset = USDC;
  if (sourceRaw) {
    if (sourceRaw === XLM.id) {
      source = XLM;
    } else if (sourceRaw === USDC.id) {
      source = USDC;
    } else {
      const parts = sourceRaw.split(":");
      if (parts.length !== 2) return null;
      const [code, issuer] = parts;
      if (!code || !issuer) return null;
      const candidate: SourceAsset = {
        id: sourceRaw,
        code,
        issuer,
        verification: "horizon-search",
        trustline: "not-checked",
      };
      try {
        stellarAsset(candidate);
      } catch {
        return null;
      }
      source = candidate;
    }
  }

  return { amount, recipient, destination, route, source };
}

function ApprovalDetails({
  approval,
  issuer,
}: {
  approval: WalletApprovalProvenance;
  issuer?: string;
}) {
  return (
    <div className={styles.assetNote}>
      <strong>Wallet approval</strong>
      <div>Account: {approval.account}</div>
      <div>Network: {approval.network}</div>
      <div>
        Operation:{" "}
        {approval.operation === "claim-settlement" ? "Claim settlement" : approval.operation}
      </div>
      {issuer && <div>Source issuer: {issuer}</div>}
    </div>
  );
}

function QuoteDetails({
  quote,
  simulation,
  simulating,
  simulationError,
}: {
  quote: LiveQuote;
  simulation?: SimulatedOperation | null;
  simulating?: boolean;
  simulationError?: string | null;
}) {
  const resourceFee = simulation?.resourceFee;
  const networkFee = simulation?.networkFee;
  const breakdown = quoteBreakdown(quote);

  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const freshness = quoteFreshness(quote, now);
  return (
    <dl className={styles.summary}>
      <div>
        <dt>Requested source amount</dt>
        <dd>{formatUnits(breakdown.requestedSourceAmount, 7)} USDC</dd>
      </div>
      <div>
        <dt>Actual source debit</dt>
        <dd>{formatUnits(breakdown.actualSourceDebit, 7)} USDC</dd>
      </div>
      <div>
        <dt>Protocol fee</dt>
        <dd>{formatUnits(breakdown.protocolFee, 7)} USDC</dd>
      </div>
      <div>
        <dt>Representable bridge amount</dt>
        <dd>{formatUnits(breakdown.representableBridgeAmount, 7)} USDC</dd>
      </div>
      <div>
        <dt>Retained precision dust</dt>
        <dd>{formatUnits(breakdown.retainedDust, 7)} USDC</dd>
      </div>
      <div>
        <dt>{quote.route === 0 ? "Circle forwarding budget" : "Axelar relay gas budget"}</dt>
        <dd>
          {formatUnits(quote.relayGas, 7)} {quote.route === 0 ? "USDC" : "XLM"}
        </dd>
      </div>
      {resourceFee !== undefined && (
        <div>
          <dt>Assembled resource fee</dt>
          <dd>{formatUnits(resourceFee, 7)} XLM</dd>
        </div>
      )}
      {networkFee !== undefined && (
        <div>
          <dt>Stellar network fee</dt>
          <dd>{formatUnits(networkFee, 7)} XLM</dd>
        </div>
      )}
      {simulating && (
        <div>
          <dt>Assembled resource fee</dt>
          <dd>Estimating simulation...</dd>
        </div>
      )}
      {simulationError && (
        <div>
          <dt>Simulation status</dt>
          <dd>Simulation failed</dd>
        </div>
      )}
      <div>
        <dt>Minimum received</dt>
        <dd>
          {formatUnits(quote.destinationAmount, destinationDecimals(quote.route))}{" "}
          {receiveSymbol(quote.route)}
        </dd>
      </div>
      <div>
        <dt>Provider observation</dt>
        <dd>
          {freshness === "current" ? "Current" : freshness === "stale" ? "Stale" : "Unknown"} ·{" "}
          {quote.observedAt ? new Date(quote.observedAt).toLocaleString() : "Not observed"}
        </dd>
      </div>
      <div>
        <dt>Contract observation</dt>
        <dd>
          {quote.observations?.contractAt
            ? new Date(quote.observations.contractAt).toLocaleString()
            : "Not observed"}{" "}
          · ledger {quote.ledger}
        </dd>
      </div>
      <div>
        <dt>Quote scope</dt>
        <dd>
          {quote.destination} · {quote.route === 0 ? "Circle CCTP" : "Axelar ITS"} · {quote.adapter}{" "}
          · ledger {quote.ledger}
          <span> · Stellar Testnet</span>
        </dd>
      </div>
    </dl>
  );
}

function ConversionIntent({
  conversion,
  addTrustline,
}: {
  conversion: Conversion;
  addTrustline: boolean;
}) {
  const intent = conversionExecutionIntent(conversion, addTrustline);
  return (
    <section className={styles.conversionIntent} aria-label="Conversion execution intent">
      <h3>Conversion execution intent</h3>
      <p>
        {intent.operation}: receive exactly {formatUnits(intent.destinationAmount, 7)} USDC while
        spending no more than {formatUnits(intent.sourceMax, 7)} {intent.source.code}.
      </p>
      <ol className={styles.conversionPath} aria-label="Conversion route">
        {conversionRoute(conversion).map((asset, index, route) => (
          <li key={`${asset.id}-${index}`} className={styles.conversionStep}>
            <strong>{asset.code}</strong>
            {asset.issuer && <span className={styles.address}>{asset.issuer}</span>}
            {index < route.length - 1 && <ArrowRight size={13} aria-hidden="true" />}
          </li>
        ))}
      </ol>
      <p>
        {intent.addTrustline
          ? "This transaction also creates the canonical USDC trustline."
          : "The canonical USDC trustline already exists."}
      </p>
    </section>
  );
}

function ConversionDetails({ conversion }: { conversion: NonNullable<TradeQuote["conversion"]> }) {
  const path = [conversion.source, ...conversion.path, USDC]
    .map((asset) =>
      asset.issuer
        ? `${asset.code} (${asset.issuer.slice(0, 7)}...${asset.issuer.slice(-7)})`
        : asset.code,
    )
    .join(" -> ");
  return (
    <p className={styles.assetNote}>
      Convert up to {formatUnits(conversion.sourceMax, 7)} {conversion.source.code} into at least{" "}
      {formatUnits(conversion.usdcAmount, 7)} Stellar USDC. Quoted path: {path}. Liquidity is
      rechecked immediately before wallet approval; signing is blocked if this minimum cannot be
      met.
    </p>
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
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<TransactionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<LiveQuote | null>(null);
  const currentAccount = useRef(wallet.address);
  useLayoutEffect(() => {
    currentAccount.current = wallet.address;
  }, [wallet.address]);
  const [cardSimulation, setCardSimulation] = useState<SimulatedOperation | null>(null);
  const [cardSimulating, setCardSimulating] = useState(false);
  const [cardSimError, setCardSimError] = useState<string | null>(null);
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
      if (result?.status === "confirmed" && checkpoint.stage === "conversion" && sameAccount) {
        const nextQuote = await quoteTransfer(
          checkpoint.destination,
          BigInt(checkpoint.bridgeAmount),
          checkpoint.route,
        );
        setReview(nextQuote);
        setCardSimulating(true);
        setCardSimError(null);
        try {
          const sim = await simulateBridgeOut(checkpoint.account, nextQuote, checkpoint.recipient);
          setCardSimulation(sim);
        } catch (simCause) {
          setCardSimulation(null);
          setCardSimError(errorMessage(simCause));
        } finally {
          setCardSimulating(false);
        }
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setChecking(false);
    }
  };
  const continueBridge = async () => {
    if (!review || !sameAccount || checking || cardSimulating || !!cardSimError || !cardSimulation)
      return;
    try {
      assertCheckpointStorage();
    } catch (cause) {
      setError(errorMessage(cause));
      return;
    }
    setChecking(true);
    setError(null);
    try {
      const result = await submitBridgeOut(
        checkpoint.account,
        review,
        checkpoint.recipient,
        (xdr, opts) => wallet.signTransaction(xdr, { ...opts, operation: "bridge" }),
        (_phase, hash) => {
          if (hash) saveCheckpoint({ ...checkpoint, stage: "bridge", txHash: hash });
        },
        { account: checkpoint.account, network: TESTNET.networkPassphrase, operation: "bridge" },
        { expectedAccount: checkpoint.account, getCurrentAccount: () => currentAccount.current },
        cardSimulation,
      );
      setChecked(result);
      setReview(null);
      setCardSimulation(null);
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
                : "Conversion source status unknown"
              : current?.status === "confirmed"
                ? "Transfer confirmed on Stellar"
                : "Transfer source status unknown"}
        </h2>
      </div>
      <p>
        {checkpoint.stage === "conversion"
          ? "Your conversion and bridge are separate transactions. Check the conversion before continuing with USDC."
          : current?.status === "confirmed"
            ? "The source transaction is confirmed. Follow destination delivery separately in transfer activity."
            : "This saved signed hash does not establish broadcast or confirmation. Check its source status before approving another transfer."}
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
      <div className={styles.transactionIdentity}>
        <span>Source transaction on Stellar Testnet</span>
        <div className={styles.transactionIdentityValue}>
          <code className={styles.transactionHash}>{checkpoint.txHash}</code>
          <button
            type="button"
            className={styles.copyHash}
            aria-label="Copy transaction hash"
            onClick={() => {
              void navigator.clipboard
                .writeText(checkpoint.txHash)
                .then(() => {
                  setCopied(true);
                })
                .catch(() => {
                  setCopied(false);
                });
            }}
          >
            <Copy size={14} aria-hidden="true" />
          </button>
        </div>
        {copied && <span role="status">Transaction hash copied.</span>}
        <a
          className={styles.transactionLink}
          href={`https://stellar.expert/explorer/testnet/tx/${checkpoint.txHash}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          View on Stellar Expert <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      </div>
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
            if (!checking) {
              setReview(null);
              setCardSimulation(null);
              setCardSimError(null);
            }
          }}
        >
          <p className={styles.reviewNote}>
            Conversion confirmed. This step bridges the USDC already in your wallet.
          </p>
          <ApprovalDetails
            approval={{
              account: checkpoint.account,
              network: TESTNET.networkPassphrase,
              operation: "bridge",
            }}
          />
          <QuoteDetails quote={review} simulation={cardSimulation} />
          <p className={styles.address}>Recipient: {checkpoint.recipient}</p>
          {cardSimulation && (
            <p className={styles.address}>
              Operation: bridge_out_with_gas ({formatUnits(cardSimulation.totalFee, 7)} XLM total
              envelope fee)
            </p>
          )}
          {cardSimError && (
            <p role="alert" className={styles.error}>
              Simulation failed: {cardSimError}. Approval blocked.
            </p>
          )}
          <button
            type="button"
            className={styles.primary}
            disabled={
              checking || !sameAccount || cardSimulating || !!cardSimError || !cardSimulation
            }
            onClick={() => {
              void continueBridge();
            }}
          >
            {checking
              ? "Confirming in your wallet..."
              : cardSimulating
                ? "Estimating simulation..."
                : cardSimError
                  ? "Approval blocked"
                  : "Bridge converted USDC"}
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
  const [reviewApproval, setReviewApproval] = useState<WalletApprovalProvenance | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [quoteVersion, setQuoteVersion] = useState(0);
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
  const [simulatedState, setSimulatedState] = useState<{
    key: string;
    value: SimulatedOperation | null;
    error: string | null;
  } | null>(null);
  const [reviewed, setReviewed] = useState<{
    key: string;
    quote: TradeQuote;
    addTrustline: boolean;
    simulation: SimulatedOperation | null;
  } | null>(null);
  const [reserve, setReserve] = useState<TrustlineReservePreview | null>(null);
  const [reserveError, setReserveError] = useState<string | null>(null);
  const laneKey = `${destination}:${route}:${refresh}`;
  const lane = laneState?.key === laneKey ? laneState.value : null;
  const laneError = laneState?.key === laneKey ? laneState.error : null;
  const quoteKey = `${laneKey}:${source.id}:${amount}:${recipient}:${quoteVersion}`;
  const quote = quoted?.key === quoteKey && lane?.available ? quoted.value : null;
  const quoteError = quoted?.key === quoteKey ? quoted.error : null;
  const simKey = `${quoteKey}:${wallet.address}`;
  const simulation = simulatedState?.key === simKey ? simulatedState.value : null;
  const simulationError = simulatedState?.key === simKey ? simulatedState.error : null;
  const balances = accounts?.account === wallet.address ? accounts.assets : [];
  const walletAsset = balances.find((asset) => asset.id === source.id);
  const activeSource: SourceAsset = useMemo(
    () => (walletAsset ? { ...source, ...walletAsset } : source),
    [source, walletAsset],
  );
  const sourceBalance =
    accounts?.account === wallet.address && !accounts.error
      ? (walletAsset?.balance ?? "0")
      : undefined;
  const liveReview = useRef({
    account: wallet.address,
    recipient,
    amount,
    sourceId: source.id,
    destination,
    route,
  });
  useLayoutEffect(() => {
    liveReview.current = {
      account: wallet.address,
      recipient,
      amount,
      sourceId: source.id,
      destination,
      route,
    };
  }, [wallet.address, recipient, amount, source.id, destination, route]);
  const spendableStr =
    accounts?.account === wallet.address && !accounts.error && walletAsset
      ? spendableBalance(walletAsset)
      : sourceBalance;
  const spendableUnits = spendableStr !== undefined ? parseUnits(spendableStr, 7) : undefined;
  const xlmAsset = balances.find((asset) => asset.id === "native");
  const xlmSpendable = xlmAsset?.available !== undefined ? parseUnits(xlmAsset.available, 7) : 0n;
  // Conservative maximum: for USDC source requires a live quote with relay pricing;
  // for non-USDC source the spendable asset balance is the binding spending cap.
  const isUsdcSource = source.id === USDC.id;
  const trustlineOk = activeSource.trustline === "present" || activeSource.trustline === "native";
  const conservativeMax: bigint | null = isUsdcSource
    ? quote !== null && lane !== null
      ? planMaxUsdcAmount({
          route,
          usdcSpendable: spendableUnits ?? 0n,
          xlmSpendable,
          flowAvailable: quote.bridge.flowAvailable,
          estimatedRelayGas: quote.bridge.estimatedRelayGas ?? quote.bridge.relayGas,
        })
      : null
    : source.id === "native"
      ? null
      : planMaxSourceAmount({
          spendableSourceUnits: spendableUnits ?? 0n,
          trustlineOk,
        });

  const locked = busy || checkpoint !== null;
  let inputError: string | null = null;
  let valid = false;
  if (amount.trim() && recipient.trim()) {
    try {
      const parsed = parseUnits(amount.trim(), 7);
      if (parsed <= 0n || parsed > (1n << 63n) - 1n)
        throw new Error("Enter a positive amount within Stellar's asset limit.");
      validateRecipient(recipient, destination);
      valid = true;
    } catch (cause) {
      inputError = errorMessage(cause);
    }
  }
  const fetching =
    valid && !locked && !laneError && (!lane || (lane.available && quoted?.key !== quoteKey));
  const simulating =
    valid &&
    !!wallet.address &&
    !!quote &&
    !quote.conversion &&
    !locked &&
    simulatedState?.key !== simKey;
  const chain = destinationFor(destination);
  const waitController = useRef<AbortController | null>(null);
  const waitGeneration = useRef(0);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  useEffect(() => {
    const generation = waitGeneration;
    return () => {
      ++generation.current;
      waitController.current?.abort();
    };
  }, [wallet.address]);
  useEffect(() => {
    const parsed = parseBridgeFormParams(window.location.search);
    if (!parsed) return;
    const timer = setTimeout(() => {
      setSource(parsed.source);
      setDestination(parsed.destination);
      setRoute(parsed.route);
      setAmount(parsed.amount);
      setRecipient(parsed.recipient);
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  const shareConfiguration = async () => {
    const params = new URLSearchParams({
      a: amount,
      r: recipient,
      d: destination,
      t: String(route),
      s: source.id,
    });
    if (!parseBridgeFormParams(`?${params}`)) {
      setShareStatus("Enter a valid amount and recipient on a supported route before sharing.");
      return;
    }
    const url = new URL("/", window.location.origin);
    url.search = params.toString();
    try {
      await navigator.clipboard.writeText(url.toString());
      setShareStatus(
        "Transfer configuration link copied. Opening it requires fresh quotes and wallet approval.",
      );
    } catch {
      setShareStatus(
        "Clipboard access is unavailable. Try sharing again after allowing clipboard access.",
      );
    }
  };

  const invalidateQuote = () => {
    setQuoteVersion((version) => version + 1);
    setQuoted(null);
  };
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
    void Promise.all([
      accountAssets(account, controller.signal),
      accountTrustlineReserve(account, controller.signal),
    ])
      .then(([assets, nextReserve]) => {
        if (!controller.signal.aborted) {
          setAccounts({ account, assets, error: null });
          setReserve(nextReserve);
          setReserveError(null);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setAccounts({ account, assets: [], error: errorMessage(cause) });
          setReserve(null);
          setReserveError(errorMessage(cause));
        }
      });
    return () => {
      controller.abort();
    };
  }, [wallet.address, result, refresh]);
  useEffect(() => {
    if (!valid || !lane?.available || locked) return;
    let active = true;
    const timer = setTimeout(() => {
      void quoteTrade(destination, activeSource, amount, route)
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
  }, [valid, lane, locked, destination, activeSource, amount, route, quoteKey]);
  useEffect(() => {
    const sender = wallet.address;
    // Conversion funds the later bridge. Simulate that bridge only after conversion confirms.
    if (!valid || !quote || quote.conversion || !sender || locked) return;
    let active = true;
    const timer = setTimeout(() => {
      void simulateBridgeOut(sender, quote.bridge, recipient)
        .then((sim) => {
          if (active) setSimulatedState({ key: simKey, value: sim, error: null });
        })
        .catch((cause: unknown) => {
          if (active) setSimulatedState({ key: simKey, value: null, error: errorMessage(cause) });
        });
    }, 450);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [valid, quote, wallet.address, locked, recipient, simKey]);

  const submit = async () => {
    if (
      !reviewed ||
      !wallet.address ||
      busy ||
      checkpoint ||
      reviewedReserveInsufficient ||
      (!!reviewed.quote.conversion && !reserve)
    )
      return;
    if (reviewApproval?.account !== wallet.address) {
      setReviewing(false);
      setReviewApproval(null);
      setReviewed(null);
      setError("Your wallet account changed. Review the transfer again.");
      return;
    }
    if (reviewed.key !== quoteKey) {
      setReviewing(false);
      setReviewed(null);
      setReviewApproval(null);
      setError("The conversion route changed. Review the updated path before signing.");
      return;
    }
    const reviewedQuote = reviewed.quote;
    try {
      assertCheckpointStorage();
    } catch (cause) {
      setError(errorMessage(cause));
      return;
    }
    setReviewing(false);
    const controller = new AbortController();
    waitController.current?.abort();
    waitController.current = controller;
    const generation = ++waitGeneration.current;
    setBusy(true);
    setError(null);
    setResult(null);
    setPhase("preparing");
    const sender = wallet.address;
    const initialRecipient = recipient;
    const initialAmount = amount;
    const initialSourceId = source.id;
    const initialDestination = destination;
    const initialRoute = route;
    let ownership: ReturnType<typeof claimOperationOwnership>;
    try {
      ownership = claimOperationOwnership({
        account: sender,
        recipient: validateRecipient(recipient, destination),
        destination,
        route,
        bridgeAmount: String(reviewedQuote.bridge.requestedAmount),
        stage: reviewedQuote.conversion ? "conversion" : "bridge",
      });
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
      setPhase(null);
      return;
    }
    const isSuperseded = () => {
      const currentOwner = getOperationOwnership();
      if (currentOwner?.id !== ownership.id) return true;
      const current = liveReview.current;
      if (
        current.recipient !== initialRecipient ||
        current.amount !== initialAmount ||
        current.sourceId !== initialSourceId ||
        current.destination !== initialDestination ||
        current.route !== initialRoute
      )
        return true;
      return false;
    };
    let converted: TransferCheckpoint | null = null;
    const pending = (stage: "conversion" | "bridge", hash: string): TransferCheckpoint => ({
      router: TESTNET.router,
      account: sender,
      recipient: validateRecipient(recipient, destination),
      destination,
      route,
      bridgeAmount: String(reviewedQuote.bridge.requestedAmount),
      stage,
      txHash: hash,
    });
    const conversionReconcile: SubmissionReconciliation = {
      expectedAccount: sender,
      getCurrentAccount: () => liveReview.current.account ?? null,
      isSuperseded,
      onAccountSwitch: (hash) => {
        saveCheckpoint(pending("conversion", hash));
      },
    };
    const bridgeReconcile: SubmissionReconciliation = {
      expectedAccount: sender,
      getCurrentAccount: () => liveReview.current.account ?? null,
      isSuperseded,
      onAccountSwitch: (hash) => {
        saveCheckpoint(pending("bridge", hash));
      },
    };
    try {
      if (reviewedQuote.conversion) {
        setStep("conversion");
        const swap = await submitConversion(
          wallet.address,
          reviewedQuote.conversion,
          (xdr, opts) => wallet.signTransaction(xdr, { ...opts, operation: "conversion" }),
          (next, hash) => {
            setPhase(next);
            if (hash) saveCheckpoint(pending("conversion", hash));
          },
          { ...reviewApproval, operation: "conversion" },
          conversionReconcile,
          controller.signal,
        );
        if (generation !== waitGeneration.current) return;
        if (swap.status !== "confirmed") {
          setResult(swap);
          if (swap.status === "failed")
            setError("The conversion failed. No bridge transaction was submitted.");
          return;
        }
        converted = pending("conversion", swap.txHash);
        saveCheckpoint(converted);
        setResult(swap);
        return;
      }
      setStep("bridge");
      setPhase("preparing");
      const submitted = await submitBridgeOut(
        wallet.address,
        reviewedQuote.bridge,
        recipient,
        (xdr, opts) => wallet.signTransaction(xdr, { ...opts, operation: "bridge" }),
        (next, hash) => {
          setPhase(next);
          if (hash) {
            saveCheckpoint(pending("bridge", hash));
            setResult({ status: "pending", txHash: hash });
          }
        },
        { ...reviewApproval, operation: "bridge" },
        bridgeReconcile,
        reviewed.simulation ?? undefined,
        controller.signal,
      );
      if (generation !== waitGeneration.current) return;
      setResult(submitted);
    } catch (cause) {
      const message = errorMessage(cause);
      if (/network rejected|Nothing was accepted/.test(message)) saveCheckpoint(converted);
      setError(message);
    } finally {
      releaseOperationOwnership(ownership.id);
      setBusy(false);
      setPhase(null);
    }
  };
  const reset = () => {
    saveCheckpoint(null);
    setResult(null);
    setError(null);
    setReviewed(null);
    setAmount("");
    setSimulatedState(null);
    setRefresh((value) => value + 1);
  };
  const insufficient = quote && spendableUnits !== undefined && spendableUnits < quote.sourceAmount;
  // Exceeds route liquidity even when the wallet balance is sufficient.
  const exceedsFlow =
    !insufficient &&
    quote !== null &&
    conservativeMax !== null &&
    quote.sourceAmount > conservativeMax &&
    isUsdcSource;

  const needsTrustline = !balances.some((asset) => asset.id === USDC.id);
  // The reserve a new trustline locks, and the network fee and (for an XLM source) the amount
  // the conversion itself spends, all come out of the same XLM balance. Fold them together here
  // so the review screen discloses the one number that actually decides whether signing is safe,
  // not just the trustline reserve in isolation.
  const reserveImpact =
    quote?.conversion && reserve
      ? trustlineReserveImpact(reserve, quote.conversion, needsTrustline)
      : null;
  const trustlineReserveInsufficient =
    !!quote?.conversion && !!reserveImpact && reserveImpact.projectedSpendable < 0n;
  const trustlineReserveUnknown = !!quote?.conversion && reserve === null;
  // The review dialog shows a frozen snapshot (`reviewed`), which can lag the live `quote` while
  // the dialog stays open, so its disclosure is computed from that same snapshot rather than from
  // whatever is live, keeping the number on screen identical to what is about to be signed.
  const reviewedImpact =
    reviewed?.quote.conversion && reserve
      ? trustlineReserveImpact(reserve, reviewed.quote.conversion, reviewed.addTrustline)
      : null;
  const reviewedReserveInsufficient = !!reviewedImpact && reviewedImpact.projectedSpendable < 0n;
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
              invalidateQuote();
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
                invalidateQuote();
                setError(null);
              }}
            />
            {wallet.address && walletAsset && source.id !== "native" && (
              <button
                type="button"
                className={styles.maxSpend}
                aria-label="Use spendable balance"
                disabled={
                  locked ||
                  conservativeMax === null ||
                  activeSource.trustline === "frozen" ||
                  activeSource.trustline === "unauthorized"
                }
                onClick={() => {
                  if (conservativeMax !== null) {
                    setAmount(formatUnits(conservativeMax, 7));
                    setError(null);
                  }
                }}
              >
                Max
              </button>
            )}
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
                ? walletAsset?.sellingLiabilities &&
                  parseUnits(walletAsset.sellingLiabilities, 7) > 0n
                  ? `Balance: ${sourceBalance} ${source.code} (Spendable: ${spendableBalance(walletAsset)} ${source.code})`
                  : `Balance: ${sourceBalance} ${source.code}`
                : (accounts?.error ?? "Reading your balance...")
              : "Choose any liquid Stellar asset"}
          </p>
          <p className={styles.balance}>
            {issuerVerificationLabel(activeSource)}. {trustlineLabel(activeSource)}.
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
              invalidateQuote();
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
            <QuoteDetails
              quote={quote.bridge}
              simulation={simulation}
              simulating={simulating}
              simulationError={simulationError}
            />
            {quote.conversion && <ConversionDetails conversion={quote.conversion} />}
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
            {walletAsset?.sellingLiabilities && parseUnits(walletAsset.sellingLiabilities, 7) > 0n
              ? `Your spendable ${source.code} balance (${spendableBalance(walletAsset)} ${source.code}) is lower than this amount due to selling liabilities.`
              : `Your ${source.code} balance is lower than this amount.`}
          </p>
        )}
        {exceedsFlow && (
          <p role="alert" className={styles.error}>
            {`This amount exceeds the available route limit. Maximum bridgeable: ${formatUnits(conservativeMax, 7)} USDC.`}
          </p>
        )}
        {quote?.conversion && reserveImpact && (
          <p className={styles.assetNote} role={trustlineReserveInsufficient ? "alert" : "status"}>
            {reserveImpact.addsTrustline
              ? `Signing also opens your USDC trustline, locking ${formatUnits(reserveImpact.trustlineReserve, 7)} XLM (${reserveImpact.trustlineReserve} stroops) in reserve. `
              : "You already hold a USDC trustline; no new reserve is locked. "}
            Network fee: {formatUnits(reserveImpact.networkFee, 7)} XLM.
            {reserveImpact.sourceSpend > 0n &&
              ` Converting spends up to ${formatUnits(reserveImpact.sourceSpend, 7)} XLM.`}{" "}
            Spendable XLM after signing: {formatUnits(reserveImpact.projectedSpendable, 7)} XLM.
          </p>
        )}
        {quote?.conversion && needsTrustline && reserveError && (
          <p className={styles.error}>{reserveError}</p>
        )}
        {result?.failure && (
          <p role="status" className={styles.assetNote}>
            {result.failure.stage === "broadcast"
              ? "The source broadcast outcome is unknown."
              : "Source confirmation is temporarily unavailable."}{" "}
            Check the saved source hash before approving another transaction.
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
        {busy && phase === "pending" && (
          <button
            type="button"
            className={styles.secondary}
            onClick={() => waitController.current?.abort()}
          >
            Stop waiting
          </button>
        )}
        <button
          type="button"
          className={styles.secondary}
          disabled={busy}
          onClick={() => {
            void shareConfiguration();
          }}
        >
          Share transfer configuration
        </button>
        {shareStatus && (
          <p role="status" className={styles.reviewNote}>
            {shareStatus}
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
              disabled={
                !quote ||
                (!quote.conversion && !simulation) ||
                busy ||
                !!insufficient ||
                sourceBalance === undefined ||
                activeSource.trustline === "frozen" ||
                activeSource.trustline === "unauthorized" ||
                trustlineReserveUnknown ||
                trustlineReserveInsufficient
              }
              onClick={() => {
                if (!wallet.address || !quote || (!quote.conversion && !simulation)) return;
                setReviewApproval({
                  account: wallet.address,
                  network: TESTNET.networkPassphrase,
                  operation: quote.conversion ? "conversion" : "bridge",
                });
                setReviewed({
                  key: quoteKey,
                  quote,
                  simulation,
                  addTrustline: needsTrustline,
                });
                setReviewing(true);
              }}
            >
              {fetching
                ? "Finding your route..."
                : simulating
                  ? "Estimating bridge fees..."
                  : simulationError
                    ? "Refresh to retry simulation"
                    : "Review transfer"}
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
            invalidateQuote();
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
            invalidateQuote();
            setError(null);
          }}
          onClose={() => {
            setPicker(null);
          }}
        />
      )}
      {reviewing && reviewed && (
        <ReviewDialog
          onClose={() => {
            setReviewing(false);
            setReviewed(null);
          }}
        >
          <div className={styles.reviewTotal}>
            <span>You send {reviewed.quote.conversion ? "up to" : ""}</span>
            <strong>
              {formatUnits(reviewed.quote.sourceAmount, 7)} {reviewed.quote.source.code}
            </strong>
            <ArrowDown size={20} aria-hidden="true" />
            <span>You receive at least</span>
            <strong>
              {formatUnits(
                reviewed.quote.bridge.destinationAmount,
                destinationDecimals(reviewed.quote.bridge.route),
              )}{" "}
              {receiveSymbol(reviewed.quote.bridge.route)}
            </strong>
          </div>
          <p className={styles.reviewNote}>
            From Stellar Testnet to {destinationFor(reviewed.quote.bridge.destination).name} via{" "}
            {provider(reviewed.quote.bridge.route)}.
          </p>
          <p className={styles.address}>Recipient: {validateRecipient(recipient, destination)}</p>
          {reviewed.quote.source.issuer && reviewed.quote.source.id !== USDC.id && (
            <p className={styles.address}>Source issuer: {reviewed.quote.source.issuer}</p>
          )}
          {reviewApproval && (
            <ApprovalDetails
              approval={reviewApproval}
              {...(reviewed.quote.source.issuer ? { issuer: reviewed.quote.source.issuer } : {})}
            />
          )}
          <p className={styles.reviewNote}>
            {issuerVerificationLabel(reviewed.quote.source)}.{" "}
            {trustlineLabel(reviewed.quote.source)}.
          </p>
          {reviewed.quote.conversion && (
            <ConversionIntent
              conversion={reviewed.quote.conversion}
              addTrustline={reviewed.addTrustline}
            />
          )}
          {reviewed.quote.conversion && reviewedImpact && (
            <p
              className={styles.reviewNote}
              role={reviewedReserveInsufficient ? "alert" : undefined}
            >
              {reviewedImpact.addsTrustline
                ? `This signature also opens your USDC trustline, locking ${formatUnits(reviewedImpact.trustlineReserve, 7)} XLM (${reviewedImpact.trustlineReserve} stroops) as reserve.`
                : "Your USDC trustline already exists; no new reserve is locked."}{" "}
              Network fee {formatUnits(reviewedImpact.networkFee, 7)} XLM
              {reviewedImpact.sourceSpend > 0n &&
                `, up to ${formatUnits(reviewedImpact.sourceSpend, 7)} XLM converted`}
              . Spendable XLM after signing: {formatUnits(reviewedImpact.projectedSpendable, 7)}{" "}
              XLM.
            </p>
          )}
          <QuoteDetails quote={reviewed.quote.bridge} simulation={reviewed.simulation} />
          {reviewed.quote.conversion && (
            <p className={styles.reviewNote}>
              Two signatures: convert to USDC, then review the bridge simulation and its fees. Price
              tolerance is 0.5%. If the bridge cannot proceed, your converted USDC remains in your
              wallet.
            </p>
          )}
          <p className={styles.reviewNote}>
            Recovery saves source hashes in this browser. Private sessions and browser cleanup can
            remove them; keep a copy of the signed source hash before leaving.
          </p>
          <p className={styles.reviewNote}>
            Source confirmation starts the transfer. Destination delivery is verified separately.
          </p>
          <p className={styles.reviewNote}>
            The signed transaction expires after {TRANSACTION_TIMEOUT_SECONDS} seconds. Expired
            signatures are never broadcast; review again to create a fresh envelope.
          </p>
          {reviewed.simulation && (
            <p className={styles.address}>
              Operation: bridge_out_with_gas ({formatUnits(reviewed.simulation.totalFee, 7)} XLM
              total envelope fee)
            </p>
          )}
          {simulationError && (
            <p role="alert" className={styles.error}>
              Simulation failed: {simulationError}. Approval blocked.
            </p>
          )}
          <button
            type="button"
            className={styles.primary}
            disabled={
              busy ||
              reviewedReserveInsufficient ||
              (!!reviewed.quote.conversion && !reserve) ||
              (!reviewed.quote.conversion && (simulating || !!simulationError || !simulation))
            }
            onClick={() => {
              void submit();
            }}
          >
            {simulating
              ? "Estimating simulation..."
              : simulationError
                ? "Approval blocked"
                : "Confirm in wallet"}{" "}
            <ArrowUpRight size={17} aria-hidden="true" />
          </button>
        </ReviewDialog>
      )}
    </>
  );
}

export function ClaimRecovery() {
  const wallet = useStellarWallet();
  const currentAccount = useRef(wallet.address);
  useLayoutEffect(() => {
    currentAccount.current = wallet.address;
  }, [wallet.address]);
  const [id, setId] = useState("");
  const [claims, setClaims] = useState<PendingClaim[]>([]);
  const [batchSupported, setBatchSupported] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TransactionResult | null>(null);
  const claimApproval: WalletApprovalProvenance | null = wallet.address
    ? {
        account: wallet.address,
        network: TESTNET.networkPassphrase,
        operation: "claim-settlement",
      }
    : null;
  const lookup = async () => {
    setBusy(true);
    setError(null);
    setClaims([]);
    setResult(null);
    try {
      const ids = id
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((value) => BigInt(value));
      setClaims(await getClaims(ids));
      setBatchSupported(ids.length > 1 ? await batchClaimSettlementSupport() : null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const loadOpenClaims = async () => {
    setBusy(true);
    setError(null);
    setClaims([]);
    setResult(null);
    try {
      const response = await fetchClaims({
        chain: "stellar-testnet",
        settled: "false",
        limit: "20",
      });
      const ids = response.claims.map((claim) => BigInt(claim.claimId));
      setId(ids.join(", "));
      setClaims(await getClaims(ids));
      setBatchSupported(ids.length > 1 ? await batchClaimSettlementSupport() : null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const settleOne = async (claim: PendingClaim) => {
    if (!wallet.address || busy) return;
    setBusy(true);
    setError(null);
    try {
      const transaction = await submitSettleClaim(
        wallet.address,
        claim.id,
        (xdr, opts) => wallet.signTransaction(xdr, { ...opts, operation: "claim" }),
        claimApproval ?? undefined,
        { expectedAccount: wallet.address, getCurrentAccount: () => currentAccount.current },
      );
      setResult(transaction);
      if (transaction.status === "confirmed") setClaims(await getClaims([claim.id]));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const settle = async () => {
    if (claims.length < 2 || !wallet.address || busy) return;
    setBusy(true);
    setError(null);
    try {
      const transaction = await submitSettleClaims(
        wallet.address,
        claims,
        wallet.signTransaction,
        claimApproval ?? undefined,
        { expectedAccount: wallet.address, getCurrentAccount: () => currentAccount.current },
      );
      setResult(transaction);
      if (transaction.status === "confirmed")
        setClaims(await getClaims(claims.map((claim) => claim.id)));
    } catch (cause) {
      try {
        setClaims(await getClaims(claims.map((claim) => claim.id)));
      } catch {
        // Keep the original contract error when the follow-up read is unavailable.
      }
      setError(
        `Batch settlement was rejected by the router: ${errorMessage(cause)} Review each claim before trying again.`,
      );
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
            Review parked claims from the indexer or enter claim numbers. Every recipient and amount
            below is re-read from the deployed Stellar router before signing.
          </p>
          <button type="button" disabled={busy} onClick={() => void loadOpenClaims()}>
            {busy ? "Checking..." : "Load parked claims"}
          </button>
          <label htmlFor="claim-id">Claim number</label>
          <input
            id="claim-id"
            inputMode="numeric"
            placeholder="1, 2, 3"
            value={id}
            onChange={(event) => {
              setId(event.target.value);
              setClaims([]);
              setBatchSupported(null);
            }}
            disabled={busy}
          />
          <button
            type="button"
            disabled={!/^\d+(?:[\s,]+\d+)*$/.test(id.trim()) || busy}
            onClick={() => void lookup()}
          >
            {busy ? "Checking..." : "Review claims"}
          </button>
          {error && (
            <p role="alert" className={styles.error}>
              {error} Claim settlement remains unavailable until the verified router deployment
              matches.
            </p>
          )}
          {claims.length > 0 && (
            <>
              <ul>
                {claims.map((claim) => (
                  <li key={claim.id.toString()}>
                    <p className={styles.address}>
                      Claim {claim.id.toString()} recipient: {claim.recipient}
                    </p>
                    <p>
                      Amount:{" "}
                      {claim.token === TESTNET.token
                        ? `${formatUnits(claim.amount, 7)} USDC`
                        : `${claim.amount} base units of ${claim.token}`}
                    </p>
                    <p>Status: {claim.settled ? "settled on chain" : "parked"}</p>
                    <p className={styles.address}>
                      Verified router: {claim.deployment.router} (revision {claim.deployment.commit}
                      , deployed at ledger {claim.deployment.deployedLedger})
                    </p>
                    <p className={styles.address}>Router WASM: {claim.deployment.wasmHash}</p>
                    {(claims.length === 1 || batchSupported === false) &&
                      !claim.settled &&
                      claimApproval && (
                        <>
                          <ApprovalDetails approval={claimApproval} />
                          <button
                            type="button"
                            disabled={!wallet.address || busy || result?.status === "pending"}
                            onClick={() => void settleOne(claim)}
                          >
                            Sign claim settlement
                          </button>
                        </>
                      )}
                  </li>
                ))}
              </ul>
              {claims.length > 1 && batchSupported === false && (
                <p>
                  Batch settlement is not supported by this router. Settle each claim separately.
                </p>
              )}
              {claims.length > 1 && batchSupported === true && claimApproval && (
                <>
                  <ApprovalDetails approval={claimApproval} />
                  <button
                    type="button"
                    disabled={!wallet.address || busy || result?.status === "pending"}
                    onClick={() => void settle()}
                  >
                    Sign batch settlement
                  </button>
                </>
              )}
              {!wallet.address && claims.some((claim) => !claim.settled) && (
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

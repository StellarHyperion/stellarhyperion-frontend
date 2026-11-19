import { createPublicClient, http, parseAbi } from "viem";
import {
  Account,
  Address,
  Asset,
  StrKey,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  type FeeBumpTransaction,
  type Transaction,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  formatUnits,
  fromHex,
  toHex,
  parseUnits,
  sorobanErrorName,
  describeError,
} from "@hyperion/protocol";
import {
  TESTNET,
  STELLAR_DEPLOYMENT,
  CIRCLE_STELLAR,
  destinationFor,
  destinationDecimals,
  deploymentIdentityMismatch,
  type BridgeRoute,
  type DestinationKey,
} from "../config/testnet";
import type { TransferCheckpoint } from "./checkpoint";
import type { WalletApprovalProvenance } from "../wallets/stellar/types";
import { Client as ContractClient } from "@stellar/stellar-sdk/contract";
import { validateProviderFee } from "../lib/fee-schema";

const ITS_ROUTE = 1;
const I128_MAX = (1n << 127n) - 1n;
export const TRANSACTION_TIMEOUT_SECONDS = 180;

export interface TransactionDeadline {
  readonly minTime: number;
  readonly maxTime: number;
  readonly remainingSeconds: number;
  readonly expired: boolean;
  readonly notYetValid: boolean;
}

export function transactionDeadline(
  transaction: unknown,
  now = Math.floor(Date.now() / 1000),
): TransactionDeadline {
  if (!transaction || typeof transaction !== "object")
    throw new Error("The transaction has no envelope time bounds.");
  const value = transaction as {
    timeBounds?: { minTime: string; maxTime: string };
    innerTransaction?: { timeBounds?: { minTime: string; maxTime: string } };
  };
  const bounds = value.timeBounds ?? value.innerTransaction?.timeBounds;
  if (!bounds) throw new Error("The transaction has no envelope time bounds.");
  const minTime = Number(bounds.minTime);
  const maxTime = Number(bounds.maxTime);
  if (
    !/^\d+$/.test(bounds.minTime) ||
    !/^\d+$/.test(bounds.maxTime) ||
    !Number.isSafeInteger(minTime) ||
    !Number.isSafeInteger(maxTime) ||
    minTime < 0 ||
    maxTime <= minTime
  )
    throw new Error("The transaction has invalid envelope time bounds.");
  return {
    minTime,
    maxTime,
    remainingSeconds: Math.max(0, maxTime - now),
    expired: now >= maxTime,
    notYetValid: now < minTime,
  };
}

export type WalletSigner = (
  xdr: string,
  opts: { networkPassphrase: string; approval?: WalletApprovalProvenance },
) => Promise<{ signedTxXdr: string }>;
export type TransactionPhase = "preparing" | "signing" | "submitting" | "pending" | "confirmed";

/**
 * Deterministic operation-state machine for prepare -> review -> sign -> checkpoint -> broadcast
 * -> confirmation. Only the listed events are allowed; anything else is rejected so that duplicate
 * send controls cannot be enabled from an invalid state. Unknown outcomes stay `pending`, bound to
 * the signed hash and account, and are never automatically resubmitted.
 */
export type SubmissionState =
  | "idle"
  | "preparing"
  | "reviewing"
  | "signing"
  | "checkpointed"
  | "broadcasting"
  | "pending"
  | "confirmed"
  | "failed"
  | "cancelled";

export type SubmissionEvent =
  | { readonly type: "PREPARE" }
  | { readonly type: "PREPARED" }
  | { readonly type: "REVIEW_APPROVED" }
  | { readonly type: "SIGNED"; readonly signedHash: string; readonly account: string }
  | { readonly type: "CHECKPOINTED" }
  | { readonly type: "BROADCAST_SENT" }
  | { readonly type: "BROADCAST_UNKNOWN" }
  | { readonly type: "CONFIRMED" }
  | { readonly type: "FAILED" }
  | { readonly type: "CANCEL" }
  | { readonly type: "RESET" };

export interface SubmissionMachineState {
  readonly state: SubmissionState;
  /** Set once signed; bound to the account and hash for unknown-outcome recovery. */
  readonly binding: { readonly signedHash: string; readonly account: string } | null;
}

const SUBMISSION_TRANSITIONS: Readonly<Record<SubmissionState, Partial<Record<SubmissionEvent["type"], SubmissionState>>>> = {
  idle: { PREPARE: "preparing" },
  preparing: { PREPARED: "reviewing", FAILED: "failed", CANCEL: "cancelled" },
  reviewing: { REVIEW_APPROVED: "signing", CANCEL: "cancelled", FAILED: "failed" },
  signing: { SIGNED: "checkpointed", CANCEL: "cancelled", FAILED: "failed" },
  checkpointed: { CHECKPOINTED: "broadcasting", FAILED: "failed" },
  broadcasting: { BROADCAST_SENT: "pending", BROADCAST_UNKNOWN: "pending", FAILED: "failed" },
  pending: { CONFIRMED: "confirmed", FAILED: "failed" },
  confirmed: { RESET: "idle" },
  failed: { RESET: "idle" },
  cancelled: { RESET: "idle" },
};

export const INITIAL_SUBMISSION: SubmissionMachineState = { state: "idle", binding: null };

export function submissionTransition(
  current: SubmissionMachineState,
  event: SubmissionEvent,
): SubmissionMachineState {
  const next = SUBMISSION_TRANSITIONS[current.state][event.type];
  if (!next) throw new Error(`Invalid submission transition: ${event.type} from ${current.state}.`);
  if (event.type === "SIGNED") {
    if (!event.signedHash || !event.account)
      throw new Error("A signed submission must be bound to an account and hash.");
    return { state: next, binding: { signedHash: event.signedHash, account: event.account } };
  }
  if (current.state === "pending" && event.type !== "CONFIRMED" && event.type !== "FAILED")
    throw new Error("Pending submissions are bound to their signed hash and cannot change otherwise.");
  if (event.type === "RESET") return INITIAL_SUBMISSION;
  return { state: next, binding: current.binding };
}

/** Send controls may only be enabled from the reviewing state, and never while a binding is pending. */
export function canEnableSendControl(current: SubmissionMachineState): boolean {
  return current.state === "reviewing" && current.binding === null;
}
export interface TransactionResult {
  status: "confirmed" | "pending" | "failed";
  txHash: string;
  nonce?: string;
  failure?: SubmissionFailure;
  reason?: string;
}
export interface CheckpointRecoveryResult {
  status: "confirmed" | "failed" | "unknown";
  source: "rpc" | "horizon" | "unknown";
  message: string;
}
export interface LiveQuote {
  route: number;
  grossAmount: bigint;
  fee: bigint;
  netAmount: bigint;
  destinationAmount: bigint;
  /**
   * `netAmount` truncated down to the destination's decimal precision, expressed in
   * destination-native base units, before the relay gas deduction folded into
   * `destinationAmount`. Equal to `netAmount` whenever source and destination decimals match
   * (Axelar ITS). This is the router's own `destination_amount`, computed from the
   * `destination_decimals` passed into `quote_routes`, so it never drifts from what is
   * actually signed.
   */
  representableAmount: bigint;
  flowAvailable: bigint;
  ledger: number;
  adapter: string;
  destination: DestinationKey;
  requestedAmount: bigint;
  relayGas: bigint;
  estimatedRelayGas?: bigint;
  readonly observedAt?: string;
  readonly observations?: { readonly contractAt: string; readonly providerAt: string };
  readonly scope?: {
    readonly destination: DestinationKey;
    readonly route: BridgeRoute;
    readonly adapter: string;
    readonly ledger: number;
  };
  resourceFee?: bigint;
  networkFee?: bigint;
}
export type QuoteFreshness = "current" | "stale" | "unknown";
const QUOTE_MAX_AGE_MS = 30_000;
export function quoteFreshness(
  quote: Pick<LiveQuote, "observedAt">,
  now = Date.now(),
): QuoteFreshness {
  const observed = Date.parse(quote.observedAt ?? "");
  if (!Number.isFinite(observed) || observed > now) return "unknown";
  return now - observed <= QUOTE_MAX_AGE_MS ? "current" : "stale";
}

export interface QuoteBreakdown {
  readonly requestedSourceAmount: bigint;
  readonly actualSourceDebit: bigint;
  readonly protocolFee: bigint;
  readonly representableBridgeAmount: bigint;
  readonly retainedDust: bigint;
}

/** Exact source units: the router leaves unrepresentable precision dust in the account. */
export function quoteBreakdown(quote: LiveQuote): QuoteBreakdown {
  const quantum = 10n ** BigInt(7 - destinationDecimals(quote.route));
  const representableBridgeAmount = quote.representableAmount * quantum;
  if (
    quote.requestedAmount <= 0n ||
    quote.requestedAmount > I128_MAX ||
    quote.fee < 0n ||
    quote.fee >= quote.requestedAmount ||
    representableBridgeAmount <= 0n ||
    representableBridgeAmount !== quote.netAmount ||
    quote.grossAmount !== quote.fee + representableBridgeAmount ||
    quote.grossAmount > quote.requestedAmount ||
    quote.requestedAmount - quote.grossAmount >= quantum ||
    quote.destinationAmount <= 0n
  )
    throw new Error("The live quote does not conserve its exact source and destination amounts.");
  return {
    requestedSourceAmount: quote.requestedAmount,
    actualSourceDebit: quote.grossAmount,
    protocolFee: quote.fee,
    representableBridgeAmount,
    retainedDust: quote.requestedAmount - quote.grossAmount,
  };
}
export interface LaneState {
  available: boolean;
  reason: string | null;
  feeBps: number | null;
  ledger: number;
  adapter: string | null;
  destinationToken?: string;
}
export interface PendingClaim {
  id: bigint;
  recipient: string;
  token: string;
  amount: bigint;
  settled: boolean;
  eligibility: ClaimPayoutEligibility;
  deployment: RouterDeploymentIdentity;
}
export interface RouterDeploymentIdentity {
  chain: string;
  router: string;
  networkPassphrase: string;
  wasmHash: string;
  commit: string;
  deployedLedger: number;
}

export function claimMatchesDeployment(
  claim: {
    deployment?: Pick<RouterDeploymentIdentity, "chain" | "router" | "wasmHash"> | null;
  } | null,
  deployment: Pick<RouterDeploymentIdentity, "chain" | "router" | "wasmHash">,
): boolean {
  return (
    claim?.deployment?.chain === deployment.chain &&
    claim.deployment.router === deployment.router &&
    claim.deployment.wasmHash === deployment.wasmHash
  );
}

export const MAX_BATCH_CLAIMS = 20;

export function supportsBatchClaimSettlement(methods: readonly xdr.ScSpecFunctionV0[]): boolean {
  return methods.some((method) => {
    const [sender, ids] = method.inputs;
    return (
      method.name.toString() === "settle_claims" &&
      method.inputs.length === 2 &&
      sender?.type.type === "scSpecTypeAddress" &&
      ids?.type.type === "scSpecTypeVec" &&
      ids.type.value.elementType.type === "scSpecTypeU64"
    );
  });
}

export type ClaimPayoutStatus = "eligible" | "ineligible" | "unknown";
export interface ClaimPayoutEligibility {
  status: ClaimPayoutStatus;
  reason: string;
  previewMethod: string | null;
  trustline: "required" | "not-required" | "unknown";
}

const CLAIM_PREVIEW_METHODS = ["preview_settle_claim", "can_settle_claim"] as const;

export function parseClaimPreview(value: unknown, method: string): ClaimPayoutEligibility {
  if (typeof value === "boolean")
    return {
      status: value ? "eligible" : "ineligible",
      reason: value
        ? "The router preview allows settlement."
        : "The router preview rejected settlement.",
      previewMethod: method,
      trustline: "unknown",
    };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return {
      status: "unknown",
      reason: "The router preview returned an unsupported response.",
      previewMethod: method,
      trustline: "unknown",
    };
  const record = value as Record<string, unknown>;
  const eligible =
    typeof record.eligible === "boolean"
      ? record.eligible
      : typeof record.can_settle === "boolean"
        ? record.can_settle
        : null;
  const trustline =
    record.trustline === true || record.trustline_required === true
      ? "required"
      : record.trustline === false || record.has_trustline === true
        ? "not-required"
        : "unknown";
  return {
    status: eligible === null ? "unknown" : eligible ? "eligible" : "ineligible",
    reason:
      typeof record.reason === "string"
        ? record.reason
        : eligible === true
          ? "The router preview allows settlement."
          : eligible === false
            ? "The router preview rejected settlement."
            : "The router preview did not report payout eligibility.",
    previewMethod: method,
    trustline,
  };
}

async function claimPayoutEligibility(id: bigint, token: string): Promise<ClaimPayoutEligibility> {
  if (token !== TESTNET.token)
    return {
      status: "ineligible",
      reason: "This claim uses a token that is not the configured Stellar USDC asset.",
      previewMethod: null,
      trustline: "unknown",
    };
  let methods: Awaited<ReturnType<typeof contractMethods>>;
  try {
    methods = await contractMethods(TESTNET.router);
  } catch {
    return {
      status: "unknown",
      reason: "The router preview methods could not be checked.",
      previewMethod: null,
      trustline: "unknown",
    };
  }
  const method = CLAIM_PREVIEW_METHODS.find((candidate) =>
    methods.some((entry) => entry.name === candidate),
  );
  if (!method)
    return {
      status: "unknown",
      reason: "This router does not expose a payout eligibility preview.",
      previewMethod: null,
      trustline: "unknown",
    };
  try {
    const result = await view(TESTNET.router, method, [nativeToScVal(id, { type: "u64" })]);
    return parseClaimPreview(result.value, method);
  } catch {
    return {
      status: "unknown",
      reason: "The router payout eligibility preview could not be completed.",
      previewMethod: method,
      trustline: "unknown",
    };
  }
}

function server() {
  return new rpc.Server(TESTNET.rpcUrl, { timeout: 15_000 });
}

export async function verifyRouterDeployment(): Promise<RouterDeploymentIdentity> {
  const rpcServer = server();
  const network = await rpcServer.getNetwork();
  if (network.passphrase !== STELLAR_DEPLOYMENT.networkPassphrase)
    throw new Error("Claim recovery is unavailable: the RPC endpoint is not Stellar Testnet.");
  if (TESTNET.router !== STELLAR_DEPLOYMENT.router)
    throw new Error(
      "Claim recovery is read-only: the configured router is not a verified deployment.",
    );
  const instance = await rpcServer.getContractInstance(TESTNET.router);
  let wasmHash: Uint8Array;
  if (instance.executable.type === "contractExecutableWasm") {
    const value = instance.executable.wasmHash;
    wasmHash = value instanceof Uint8Array ? value : value.toBytes();
  } else if (instance.executable.type === "contractExecutableExternalRef")
    wasmHash = await rpcServer.getExternalRefWasmHash(instance.executable.externalRef);
  else
    throw new Error(
      "Claim recovery is read-only: the router has no supported contract executable.",
    );
  const actual = toHex(wasmHash).slice(2).toLowerCase();
  if (actual !== STELLAR_DEPLOYMENT.wasmHash.toLowerCase())
    throw new Error("Claim recovery is read-only: the router revision is not verified.");
  return {
    chain: STELLAR_DEPLOYMENT.chain,
    router: STELLAR_DEPLOYMENT.router,
    networkPassphrase: STELLAR_DEPLOYMENT.networkPassphrase,
    wasmHash: actual,
    commit: STELLAR_DEPLOYMENT.commit,
    deployedLedger: STELLAR_DEPLOYMENT.deployedLedger,
  };
}

async function readWithRetry<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!/fetch failed|timeout|timed out|429|502|503|504|ECONN/i.test(String(error))) throw error;
    await new Promise((resolve) => setTimeout(resolve, 300));
    return read();
  }
}
const capabilityCache = new Map<
  string,
  { expires: number; promise: ReturnType<rpc.Server["getContractMethods"]> }
>();
function contractMethods(contract: string) {
  const key = `${TESTNET.rpcUrl}:${contract}`;
  const cached = capabilityCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise;
  // Capability discovery downloads WASM. Keep it separate from fresh state and pricing reads.
  const promise = readWithRetry(() => server().getContractMethods(contract)).catch(
    (error: unknown) => {
      capabilityCache.delete(key);
      throw error;
    },
  );
  capabilityCache.set(key, { expires: Date.now() + 60000, promise });
  return promise;
}

export function errorMessage(error: unknown): string {
  if (error instanceof SubmissionFailure) {
    const label = {
      build: "Transaction preparation",
      simulation: "Transaction simulation",
      approval: "Wallet approval",
      checkpoint: "Recovery checkpoint",
      broadcast: "Source broadcast",
      confirmation: "Source confirmation",
    }[error.stage];
    return `${label}: ${error.message}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = /Error\(Contract, #(\d+)\)/.exec(message)?.[1];
  if (code) {
    const name = sorobanErrorName(Number(code));
    if (name) return `${name}: ${describeError(name).summary}`;
  }
  return message.split("\n")[0] ?? "The network request failed. Please try again.";
}

export type SubmissionFailureStage =
  "build" | "simulation" | "approval" | "checkpoint" | "broadcast" | "confirmation";

export class SubmissionFailure extends Error {
  constructor(
    readonly stage: SubmissionFailureStage,
    message: string,
    readonly txHash?: string,
  ) {
    super(message);
    this.name = "SubmissionFailure";
  }
}

export function classifySubmissionFailure(
  stage: SubmissionFailureStage,
  error: unknown,
  txHash?: string,
): SubmissionFailure {
  if (error instanceof SubmissionFailure) return error;
  const message = errorMessage(error).slice(0, 400);
  const publicHash =
    (stage === "broadcast" || stage === "confirmation") && /^[0-9a-f]{64}$/i.test(txHash ?? "")
      ? txHash
      : undefined;
  return new SubmissionFailure(stage, message, publicHash);
}

async function submissionStage<T>(
  stage: SubmissionFailureStage,
  action: () => T | Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw classifySubmissionFailure(stage, error);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The contract returned an unexpected response.");
  }
  return value as Record<string, unknown>;
}
function integer(value: unknown): bigint {
  if (typeof value !== "bigint" && typeof value !== "number" && typeof value !== "string") {
    throw new Error("The contract returned an invalid amount.");
  }
  return BigInt(value);
}
function address(value: unknown): string {
  if (typeof value !== "string") throw new Error("The contract returned an invalid address.");
  Address.fromString(value);
  return value;
}

async function view(contract: string, method: string, args: xdr.ScVal[] = []) {
  const client = server();
  const tx = new TransactionBuilder(new Account(TESTNET.reader, "0"), {
    fee: BASE_FEE,
    networkPassphrase: TESTNET.networkPassphrase,
  })
    .addOperation(new Contract(contract).call(method, ...args))
    .setTimeout(60)
    .build();
  const response = await readWithRetry(() => client.simulateTransaction(tx));
  if (!rpc.Api.isSimulationSuccess(response)) {
    throw new Error(
      rpc.Api.isSimulationError(response)
        ? response.error
        : "Contract state needs restoration before it can be used.",
    );
  }
  if (!response.result) throw new Error("The simulation returned no contract result.");
  return {
    value: scValToNative(response.result.retval) as unknown,
    ledger: response.latestLedger,
  };
}

export function parseSendAmount(value: string): bigint {
  const amount = parseUnits(value.trim(), 7);
  if (amount <= 0n || amount > I128_MAX)
    throw new Error("Enter a positive USDC amount within the contract limit.");
  return amount;
}

export function validateRecipient(value: string): string {
  const recipient = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient) || /^0x0{40}$/.test(recipient)) {
    throw new Error("Enter a nonzero, 20-byte EVM recipient address on the selected testnet.");
  }
  return recipient;
}

export async function readLane(
  destinationKey: DestinationKey,
  route: BridgeRoute = 1,
): Promise<LaneState> {
  const destination = destinationFor(destinationKey);
  const deploymentMismatch = deploymentIdentityMismatch(TESTNET.router, TESTNET.token);
  if (deploymentMismatch)
    return {
      available: false,
      reason: deploymentMismatch,
      feeBps: null,
      ledger: 0,
      adapter: null,
    };
  if (!destination.routes.includes(route))
    return {
      available: false,
      reason: "This bridge does not have an independently verified lane to this testnet.",
      feeBps: null,
      ledger: 0,
      adapter: null,
    };
  const [configResult, tokenResult, enabledResult] = await Promise.all([
    view(TESTNET.router, "get_config"),
    view(TESTNET.router, "get_token", [new Address(TESTNET.token).toScVal()]),
    view(TESTNET.router, "is_route_enabled", [nativeToScVal(route, { type: "u32" })]),
  ]);
  const config = object(configResult.value);
  const token = object(tokenResult.value);
  const base = {
    feeBps: Number(config.fee_bps),
    ledger: configResult.ledger,
    adapter: null,
  };
  if (config.paused === true)
    return { ...base, available: false, reason: "New transfers are paused by the operator." };
  if (token.enabled !== true)
    return { ...base, available: false, reason: "USDC is disabled on the router." };
  if (enabledResult.value !== true)
    return {
      ...base,
      available: false,
      reason: `${route === 0 ? "Circle CCTP" : "Axelar ITS"} is not enabled on the router.`,
    };
  const adapterResult = await view(TESTNET.router, "get_adapter", [
    nativeToScVal(route, { type: "u32" }),
  ]);
  const adapter = address(adapterResult.value);
  const adapterConfig = object((await view(adapter, "get_config")).value);
  if (route === 0) {
    if (
      adapterConfig.router !== TESTNET.router ||
      adapterConfig.token_messenger !== CIRCLE_STELLAR.messenger ||
      adapterConfig.message_transmitter !== CIRCLE_STELLAR.transmitter ||
      adapterConfig.min_finality_threshold !== 2000
    )
      throw new Error("Circle adapter configuration does not match this testnet.");
    const [
      linkResult,
      messengerPaused,
      transmitterPaused,
      remoteMessenger,
      methods,
      routerMethods,
    ] = await Promise.all([
      view(adapter, "get_link", [nativeToScVal(destination.cctpDomain, { type: "u32" })]),
      view(CIRCLE_STELLAR.messenger, "paused"),
      view(CIRCLE_STELLAR.transmitter, "paused"),
      view(CIRCLE_STELLAR.messenger, "get_remote_token_messenger", [
        nativeToScVal(destination.cctpDomain, { type: "u32" }),
      ]),
      contractMethods(adapter),
      contractMethods(TESTNET.router),
    ]);
    const link = object(linkResult.value);
    if (
      link.chain !== destinationKey ||
      !(link.destination_caller instanceof Uint8Array) ||
      link.destination_caller.some((byte) => byte !== 0)
    )
      throw new Error("Circle destination forwarding is not configured for this network.");
    if (messengerPaused.value === true || transmitterPaused.value === true)
      return { ...base, adapter, available: false, reason: "Circle has paused this lane." };
    if (
      !(remoteMessenger.value instanceof Uint8Array) ||
      toHex(remoteMessenger.value).toLowerCase() !==
        `0x${destination.messenger.slice(2).padStart(64, "0")}`.toLowerCase()
    )
      throw new Error("Circle's remote messenger does not match the selected network.");
    if (
      !methods.some((method) => method.name === "dispatch_from") ||
      !routerMethods.some((method) => method.name === "supports_paid_route")
    )
      return {
        ...base,
        adapter,
        available: false,
        reason: "Circle forwarding is awaiting router activation.",
      };
    const remote = createPublicClient({
      transport: http(destination.rpcUrl, { timeout: 15000, retryCount: 1, retryDelay: 300 }),
    });
    if ((await remote.getChainId()) !== destination.chainId)
      throw new Error("The destination RPC is on the wrong network.");
    const decimals = await remote.readContract({
      address: destination.usdc,
      abi: parseAbi(["function decimals() view returns (uint8)"]),
      functionName: "decimals",
    });
    if (decimals !== 6) throw new Error("Native USDC precision does not match this lane.");
    return { ...base, adapter, available: true, reason: null, destinationToken: destination.usdc };
  }
  if (adapterConfig.router !== TESTNET.router || adapterConfig.route !== ITS_ROUTE) {
    throw new Error("The configured adapter does not match this router and route.");
  }
  let link: Record<string, unknown>;
  try {
    link = object(
      (await view(adapter, "get_link", [nativeToScVal(destination.key, { type: "string" })])).value,
    );
  } catch (error) {
    if (!String(error).includes("Error(Contract, #19)")) throw error;
    return {
      ...base,
      adapter,
      available: false,
      reason: `The operator has not linked the ${destination.name} lane.`,
    };
  }
  if (link.axelar_chain !== destination.axelarName)
    throw new Error("The lane points to a different destination network.");
  const its = address(adapterConfig.its);
  const trusted = await view(its, "is_trusted_chain", [
    nativeToScVal(destination.axelarName, { type: "string" }),
  ]);
  if (trusted.value !== true)
    return {
      ...base,
      adapter,
      available: false,
      reason: "Axelar has not enabled this destination.",
    };
  let destinationToken: string | null = null;
  try {
    const id = await view(adapter, "token_id_for", [new Address(TESTNET.token).toScVal()]);
    const registered = await view(its, "registered_token_address", [nativeToScVal(id.value)]);
    if (registered.value !== TESTNET.token)
      throw new Error("The adapter token mapping does not match Stellar USDC.");
    const remote = createPublicClient({
      transport: http(destination.rpcUrl, { timeout: 15_000, retryCount: 1, retryDelay: 300 }),
    });
    if ((await remote.getChainId()) !== destination.chainId)
      throw new Error("The destination RPC is on the wrong network.");
    const remoteAbi = parseAbi([
      "function registeredTokenAddress(bytes32 tokenId) view returns (address)",
      "function decimals() view returns (uint8)",
    ]);
    const remoteToken = await remote.readContract({
      address: destination.its,
      abi: remoteAbi,
      functionName: "registeredTokenAddress",
      args: [toHex(id.value as Uint8Array)],
    });
    if (/^0x0{40}$/.test(remoteToken))
      throw new Error("This ITS token is not deployed on the destination.");
    const decimals = await remote.readContract({
      address: remoteToken,
      abi: remoteAbi,
      functionName: "decimals",
    });
    if (decimals !== destination.decimals)
      throw new Error("The destination token precision does not match this lane.");
    destinationToken = remoteToken;
  } catch (error) {
    if (!String(error).includes("Error(Contract, #39)")) throw error;
    return {
      ...base,
      adapter,
      available: false,
      reason: "The operator has not linked USDC to an ITS token.",
    };
  }
  const [methods, routerMethods] = await Promise.all([
    contractMethods(adapter),
    contractMethods(TESTNET.router),
  ]);
  if (
    !methods.some((method) => method.name === "dispatch_from") ||
    !routerMethods.some((method) => method.name === "bridge_out_with_gas")
  ) {
    return {
      ...base,
      adapter,
      available: false,
      reason: "The operator must update the router and ITS adapter to support relay gas payments.",
    };
  }
  return {
    ...base,
    adapter,
    available: true,
    reason: null,
    ...(destinationToken ? { destinationToken } : {}),
  };
}

export async function quoteTransfer(
  destinationKey: DestinationKey,
  amount: bigint,
  route: BridgeRoute = 1,
): Promise<LiveQuote> {
  if (amount <= 0n || amount > I128_MAX) throw new Error("Enter a valid transfer amount.");
  const lane = await readLane(destinationKey, route);
  if (!lane.available || !lane.adapter) throw new Error(lane.reason ?? "This lane is unavailable.");
  const response = await view(TESTNET.router, "quote_routes", [
    new Address(TESTNET.token).toScVal(),
    nativeToScVal(amount, { type: "i128" }),
    nativeToScVal(destinationDecimals(route), { type: "u32" }),
  ]);
  const contractAt = new Date().toISOString();
  if (!Array.isArray(response.value)) throw new Error("The router returned an invalid quote.");
  const quote = response.value.map(object).find((q) => q.route === route);
  if (!quote) throw new Error("The router did not quote this bridge.");
  if (quote.available !== true) {
    const name = sorobanErrorName(Number(quote.reason));
    throw new Error(
      name ? `${name}: ${describeError(name).summary}` : "The router declined this amount.",
    );
  }
  const feeResponse = await readWithRetry(async () => {
    const response = await fetch(
      route === 0 ? `/api/cctp-fee?destination=${destinationKey}` : "/api/relay-fee",
      {
        signal: AbortSignal.timeout(20_000),
        cache: "no-store",
      },
    );
    if (response.status === 503)
      throw new Error("503: Live bridge pricing is temporarily unavailable. Try again.");
    return response;
  });
  if (!feeResponse.ok) throw new Error("Bridge fee pricing is unavailable. Try again later.");
  const providerDestination =
    route === 0 ? destinationKey : destinationFor(destinationKey).axelarName;
  if (!providerDestination) throw new Error("This destination has no configured provider chain.");
  const fee = validateProviderFee(await feeResponse.json(), {
    token: route === 0 ? "USDC" : "XLM",
    destination: providerDestination,
  });
  const providerAt = new Date().toISOString();
  const relayGas = integer(object(fee).amount);
  const estimatedRelayGas = integer(object(fee).estimatedAmount ?? relayGas);
  if (estimatedRelayGas <= 0n || estimatedRelayGas > relayGas)
    throw new Error("Invalid live fee estimate.");
  if (relayGas <= 0n || relayGas > I128_MAX) throw new Error("Invalid relay gas estimate.");
  // See `quoteBreakdown` for what this quantum represents: it must divide the relay gas
  // exactly so the gas deduction below lands on a destination-representable boundary too.
  const quantum = 10n ** BigInt(7 - destinationDecimals(route));
  if (route === 0 && (relayGas % quantum !== 0n || relayGas >= integer(quote.net_amount)))
    throw new Error("Increase the amount to cover Circle's destination forwarding fee.");
  const representableAmount = integer(quote.destination_amount);
  const result: LiveQuote = {
    relayGas,
    estimatedRelayGas,
    route,
    adapter: lane.adapter,
    destination: destinationKey,
    requestedAmount: amount,
    grossAmount: integer(quote.gross_amount),
    fee: integer(quote.fee),
    netAmount: integer(quote.net_amount),
    destinationAmount: representableAmount - (route === 0 ? relayGas / quantum : 0n),
    representableAmount,
    flowAvailable: integer(quote.flow_available),
    ledger: response.ledger,
    observedAt: providerAt,
    observations: { contractAt, providerAt },
    scope: {
      destination: destinationKey,
      route,
      adapter: lane.adapter,
      ledger: response.ledger,
    },
  };
  quoteBreakdown(result);
  return result;
}

export async function readBalance(account: string): Promise<bigint> {
  return integer((await view(TESTNET.token, "balance", [new Address(account).toScVal()])).value);
}

function map(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.entries(fields)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })),
  );
}

export function bridgeOperation(sender: string, quote: LiveQuote, recipientInput: string) {
  const recipient = validateRecipient(recipientInput);
  const destination = destinationFor(quote.destination);
  return new Contract(TESTNET.router).call(
    "bridge_out_with_gas",
    new Address(sender).toScVal(),
    map({
      token: new Address(TESTNET.token).toScVal(),
      amount: nativeToScVal(quote.requestedAmount, { type: "i128" }),
      route: nativeToScVal(quote.route, { type: "u32" }),
      destination: map({
        chain: nativeToScVal(destination.key, { type: "string" }),
        address: nativeToScVal(fromHex(`0x${recipient.slice(2).padStart(64, "0")}`)),
      }),
      destination_decimals: nativeToScVal(destinationDecimals(quote.route), { type: "u32" }),
      min_destination_amount: nativeToScVal(quote.destinationAmount, { type: "i128" }),
    }),
    nativeToScVal(quote.relayGas, { type: "i128" }),
  );
}

const MAX_TRANSACTION_READ_SOURCES = 3;
function transactionReadSources(): string[] {
  const configuration = process.env.NEXT_PUBLIC_STELLAR_READ_RPC_URLS ?? "";
  if (configuration.length > 4096)
    throw new Error("Stellar transaction read source configuration is too large.");
  const configured = configuration
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  const sources: string[] = [];
  const origins = new Set<string>();
  for (const endpoint of [TESTNET.rpcUrl, ...configured]) {
    const url = new URL(endpoint);
    if (
      endpoint.length > 2048 ||
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error("Stellar transaction read sources must be public HTTP(S) endpoints.");
    if (origins.has(url.origin)) continue;
    origins.add(url.origin);
    sources.push(url.toString());
    if (sources.length === MAX_TRANSACTION_READ_SOURCES) break;
  }
  return sources;
}
class ConflictingTransactionEvidence extends Error {}
interface RpcReadEvidence {
  response: rpc.Api.GetTransactionResponse;
  transaction: TransactionResult;
  fingerprint: string | null;
}
async function readTransactionFrom(
  url: string,
  hash: string,
  signal: AbortSignal,
): Promise<RpcReadEvidence> {
  const client = new rpc.Server(url, { timeout: 5000, allowHttp: url.startsWith("http:") });
  const network = await abortable(client.getNetwork(), signal);
  if (network.passphrase !== TESTNET.networkPassphrase)
    throw new ConflictingTransactionEvidence("The RPC endpoint is not Stellar Testnet.");
  const response = await abortable(client.getTransaction(hash), signal);
  if (response.status === rpc.Api.GetTransactionStatus.NOT_FOUND)
    return { response, transaction: { status: "pending", txHash: hash }, fingerprint: null };
  const envelopeXdr = response.envelopeXdr.toXdr("base64");
  const resultXdr = response.resultXdr.toXdr("base64");
  if (envelopeXdr.length > 200000 || resultXdr.length > 200000)
    throw new ConflictingTransactionEvidence("RPC transaction evidence exceeds the size limit.");
  const envelope = TransactionBuilder.fromXdr(envelopeXdr, TESTNET.networkPassphrase);
  const succeeded = response.status === rpc.Api.GetTransactionStatus.SUCCESS;
  if (
    response.txHash.toLowerCase() !== hash ||
    response.feeBump ||
    "innerTransaction" in envelope ||
    toHex(envelope.hash()).slice(2).toLowerCase() !== hash ||
    (response.resultXdr.result.type === "txSuccess") !== succeeded ||
    response.resultXdr.result.type === "txFeeBumpInnerSuccess" ||
    response.resultXdr.result.type === "txFeeBumpInnerFailed"
  )
    throw new ConflictingTransactionEvidence("RPC returned conflicting transaction evidence.");
  const returnValue =
    response.status === rpc.Api.GetTransactionStatus.SUCCESS ? response.returnValue : undefined;
  const value: unknown = returnValue ? scValToNative(returnValue) : undefined;
  return {
    response,
    transaction: {
      status: succeeded ? "confirmed" : "failed",
      txHash: hash,
      ...(typeof value === "bigint" ? { nonce: String(value) } : {}),
    },
    fingerprint: resultXdr + ":" + (returnValue?.toXdr("base64") ?? ""),
  };
}
async function collectTransactionEvidence(hash: string, signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Transaction lookup cancelled.", "AbortError");
  const readSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
    : AbortSignal.timeout(5000);
  const sources = transactionReadSources();
  const reads = await Promise.allSettled(
    sources.map((url) => readTransactionFrom(url, hash, readSignal)),
  );
  if (signal?.aborted) throw new DOMException("Transaction lookup cancelled.", "AbortError");
  const results = reads.flatMap((read) => (read.status === "fulfilled" ? [read.value] : []));
  const invalid = reads.some(
    (read) => read.status === "rejected" && read.reason instanceof ConflictingTransactionEvidence,
  );
  const complete = results.length === sources.length;
  const statuses = new Set(results.map((result) => result.transaction.status));
  const fingerprints = new Set(results.map((result) => result.fingerprint));
  const agreed = !invalid && complete && statuses.size === 1 && fingerprints.size === 1;
  return { results, invalid, complete, agreed };
}
export async function readTransaction(
  hash: string,
  signal?: AbortSignal,
): Promise<TransactionResult | null> {
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) return null;
  hash = hash.toLowerCase();
  const evidence = await collectTransactionEvidence(hash, signal);
  const result = evidence.results[0];
  if (evidence.agreed && result) return result.transaction;
  return {
    status: "pending",
    txHash: hash,
    reason:
      evidence.invalid || evidence.complete
        ? "Stellar transaction sources disagree; its outcome remains unknown."
        : "A Stellar transaction source is unavailable; its outcome remains unknown.",
  };
}

function unknownRecovery(message: string): CheckpointRecoveryResult {
  return { status: "unknown", source: "unknown", message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

type ParsedOperation = Transaction["operations"][number];

function matchesConversion(checkpoint: TransferCheckpoint, operations: ParsedOperation[]) {
  const payments = operations.filter((operation) => operation.type === "pathPaymentStrictReceive");
  if (
    payments.length !== 1 ||
    operations.length > 2 ||
    operations.some((operation) => operation.source && operation.source !== checkpoint.account)
  )
    return false;
  if (
    operations.some(
      (operation) =>
        operation.type !== "pathPaymentStrictReceive" &&
        (operation.type !== "changeTrust" ||
          !(operation.line instanceof Asset) ||
          operation.line.getCode() !== TESTNET.usdcCode ||
          operation.line.getIssuer() !== TESTNET.usdcIssuer),
    )
  )
    return false;
  const payment = payments[0];
  return (
    payment?.type === "pathPaymentStrictReceive" &&
    (!payment.source || payment.source === checkpoint.account) &&
    payment.destination === checkpoint.account &&
    payment.destAsset.getCode() === TESTNET.usdcCode &&
    payment.destAsset.getIssuer() === TESTNET.usdcIssuer &&
    parseUnits(payment.destAmount, 7) === BigInt(checkpoint.bridgeAmount)
  );
}

function numericValue(value: unknown, expected: bigint): boolean {
  return (
    value === expected ||
    (typeof value === "number" && Number.isSafeInteger(value) && BigInt(value) === expected)
  );
}

function matchesBridge(checkpoint: TransferCheckpoint, operation: ParsedOperation | undefined) {
  if (
    operation?.type !== "invokeHostFunction" ||
    (operation.source !== undefined && operation.source !== checkpoint.account) ||
    operation.func.type !== "hostFunctionTypeInvokeContract"
  )
    return false;
  const invocation = operation.func.invokeContract;
  if (invocation.functionName.toString() !== "bridge_out_with_gas") return false;
  if (
    invocation.contractAddress.type !== "scAddressTypeContract" ||
    StrKey.encodeContract(invocation.contractAddress.contractId.toBytes()) !== TESTNET.router
  )
    return false;
  const args = invocation.args;
  if (args.length !== 3 || !args[0] || !args[1] || !args[2]) return false;
  const sender: unknown = scValToNative(args[0]);
  const request: unknown = scValToNative(args[1]);
  const relayGas: unknown = scValToNative(args[2]);
  if (!isRecord(request) || !isRecord(request.destination)) return false;
  const destination = destinationFor(checkpoint.destination);
  const expectedRecipient = fromHex(`0x${checkpoint.recipient.slice(2).padStart(64, "0")}`);
  const actualRecipient = request.destination.address;
  return (
    sender === checkpoint.account &&
    request.token === TESTNET.token &&
    numericValue(request.amount, BigInt(checkpoint.bridgeAmount)) &&
    numericValue(request.route, BigInt(checkpoint.route)) &&
    request.destination.chain === destination.key &&
    actualRecipient instanceof Uint8Array &&
    toHex(actualRecipient) === toHex(expectedRecipient) &&
    numericValue(request.destination_decimals, BigInt(destinationDecimals(checkpoint.route))) &&
    typeof request.min_destination_amount === "bigint" &&
    request.min_destination_amount > 0n &&
    typeof relayGas === "bigint" &&
    relayGas > 0n
  );
}

function inspectCheckpointEnvelope(
  checkpoint: TransferCheckpoint,
  envelopeXdr: string,
  resultXdr: string,
  successful: boolean | null,
): "confirmed" | "failed" | null {
  try {
    if (
      checkpoint.router !== TESTNET.router ||
      envelopeXdr.length > 200_000 ||
      resultXdr.length > 200_000
    )
      return null;
    const transaction = TransactionBuilder.fromXdr(envelopeXdr, TESTNET.networkPassphrase);
    if (
      "innerTransaction" in transaction ||
      transaction.source !== checkpoint.account ||
      toHex(transaction.hash()).slice(2).toLowerCase() !== checkpoint.txHash
    )
      return null;
    const matches =
      checkpoint.stage === "conversion"
        ? matchesConversion(checkpoint, transaction.operations)
        : transaction.operations.length === 1 &&
          matchesBridge(checkpoint, transaction.operations[0]);
    if (!matches) return null;
    const transactionResult = xdr.TransactionResult.fromXdr(resultXdr, "base64");
    const resultSucceeded = transactionResult.result.type === "txSuccess";
    if (successful !== null && successful !== resultSucceeded) return null;
    if (
      transactionResult.result.type === "txFeeBumpInnerSuccess" ||
      transactionResult.result.type === "txFeeBumpInnerFailed"
    )
      return null;
    if (transactionResult.result.type === "txSuccess") {
      const results = transactionResult.result.results;
      if (results.length !== transaction.operations.length) return null;
      for (const [index, operation] of transaction.operations.entries()) {
        const result = results[index];
        if (result?.type !== "opInner" || result.tr.type !== operation.type) return null;
        if (result.tr.type === "pathPaymentStrictReceive") {
          const payment = result.tr.pathPaymentStrictReceiveResult;
          if (payment.type !== "pathPaymentStrictReceiveSuccess") return null;
          const last = payment.success.last;
          const asset = Asset.fromOperation(last.asset);
          if (
            StrKey.encodeEd25519PublicKey(last.destination.ed25519.toBytes()) !==
              checkpoint.account ||
            asset.getCode() !== TESTNET.usdcCode ||
            asset.getIssuer() !== TESTNET.usdcIssuer ||
            last.amount !== BigInt(checkpoint.bridgeAmount)
          )
            return null;
        } else if (result.tr.type === "changeTrust") {
          if (result.tr.changeTrustResult.type !== "changeTrustSuccess") return null;
        } else if (
          result.tr.type !== "invokeHostFunction" ||
          result.tr.invokeHostFunctionResult.type !== "invokeHostFunctionSuccess"
        )
          return null;
      }
    }
    return resultSucceeded ? "confirmed" : "failed";
  } catch {
    return null;
  }
}

function recoveryResult(
  status: "confirmed" | "failed",
  source: "rpc" | "horizon",
): CheckpointRecoveryResult {
  return {
    status,
    source,
    message:
      source === "horizon"
        ? `The transaction ${status === "confirmed" ? "was confirmed" : "failed"} in Stellar Testnet history.`
        : `The transaction ${status === "confirmed" ? "was confirmed" : "failed"} on Stellar Testnet.`,
  };
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(new DOMException("Recovery lookup cancelled.", "AbortError"));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Recovery lookup cancelled.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (cause: unknown) => {
        cleanup();
        reject(cause instanceof Error ? cause : new Error("Recovery read failed."));
      },
    );
  });
}

async function boundedHistoryJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const limit = 512_000;
  if (Number(response.headers.get("content-length")) > limit || !response.body)
    throw new Error("Historical evidence is too large or unavailable.");
  const reader = response.body.getReader();
  let bytes = 0;
  let text = "";
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error("Historical evidence exceeds the size limit.");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    void reader.cancel().catch(() => {
      // The finished or aborted stream has already been released.
    });
  }
}

export async function resolveCheckpointTransaction(
  checkpoint: TransferCheckpoint,
  signal?: AbortSignal,
): Promise<CheckpointRecoveryResult> {
  if (signal?.aborted) throw new DOMException("Recovery lookup cancelled.", "AbortError");
  if (!/^[0-9a-f]{64}$/.test(checkpoint.txHash) || checkpoint.router !== TESTNET.router)
    return unknownRecovery("The saved checkpoint does not match the configured Stellar Testnet.");
  const lookupSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
    : AbortSignal.timeout(15000);
  try {
    const evidence = await collectTransactionEvidence(checkpoint.txHash, lookupSignal);
    const final = evidence.results.filter((result) => result.transaction.status !== "pending");
    if (evidence.invalid || (final.length > 0 && !evidence.agreed))
      return unknownRecovery(
        "Stellar RPC sources disagree or returned unverified evidence. The saved checkpoint is unchanged.",
      );
    if (evidence.agreed && final.length > 0) {
      for (const result of final) {
        if (result.response.status === rpc.Api.GetTransactionStatus.NOT_FOUND)
          return unknownRecovery("Stellar RPC history is incomplete.");
        const verified = inspectCheckpointEnvelope(
          checkpoint,
          result.response.envelopeXdr.toXdr("base64"),
          result.response.resultXdr.toXdr("base64"),
          result.transaction.status === "confirmed",
        );
        if (!verified)
          return unknownRecovery("RPC returned conflicting or invalid checkpoint evidence.");
      }
      const result = final[0];
      if (result && result.transaction.status !== "pending")
        return recoveryResult(result.transaction.status, "rpc");
    }
  } catch (cause) {
    if (signal?.aborted) throw cause;
    return unknownRecovery(
      "Stellar RPC read configuration could not be verified. The saved checkpoint is unchanged.",
    );
  }

  try {
    const networkResponse = await fetch(TESTNET.horizonUrl, {
      signal: lookupSignal,
      cache: "no-store",
    });
    const network: unknown = networkResponse.ok
      ? await boundedHistoryJson(networkResponse, lookupSignal)
      : null;
    if (!isRecord(network) || network.network_passphrase !== TESTNET.networkPassphrase)
      return unknownRecovery("Historical evidence does not establish the Stellar Testnet network.");
    const response = await fetch(
      `${TESTNET.horizonUrl}/transactions/${encodeURIComponent(checkpoint.txHash)}`,
      {
        signal: lookupSignal,
        cache: "no-store",
      },
    );
    if (signal?.aborted) throw new DOMException("Recovery lookup cancelled.", "AbortError");
    if (response.status === 404)
      return unknownRecovery("No matching transaction is available in Stellar Testnet history.");
    if (!response.ok)
      return unknownRecovery("Stellar Testnet transaction history is temporarily unavailable.");
    const body: unknown = await boundedHistoryJson(response, lookupSignal);
    if (
      !isRecord(body) ||
      body.hash !== checkpoint.txHash ||
      body.source_account !== checkpoint.account ||
      typeof body.successful !== "boolean" ||
      typeof body.envelope_xdr !== "string" ||
      typeof body.result_xdr !== "string"
    )
      return unknownRecovery("Historical transaction evidence is incomplete or does not match.");
    const verified = inspectCheckpointEnvelope(
      checkpoint,
      body.envelope_xdr,
      body.result_xdr,
      body.successful,
    );
    if (!verified)
      return unknownRecovery("Historical transaction evidence conflicts with this checkpoint.");
    return recoveryResult(verified, "horizon");
  } catch (cause) {
    if (signal?.aborted) throw cause;
    return unknownRecovery(
      "Stellar Testnet history could not be checked. The saved checkpoint is unchanged.",
    );
  }
}

export interface ReviewSnapshot {
  account: string;
  recipient: string;
  destination: DestinationKey;
  route: BridgeRoute;
  bridgeAmount: bigint;
  stage: "conversion" | "bridge";
  sourceId?: string;
  sourceAmount?: bigint;
  resourceFee?: bigint;
  networkFee?: bigint;
}

export interface SubmissionReconciliation {
  expectedAccount: string;
  getCurrentAccount?: () => string | null;
  isSuperseded?: () => boolean;
  onAccountSwitch?: (
    hash: string,
    signedTx: Transaction | FeeBumpTransaction,
  ) => void | Promise<void>;
  validate?: (hash: string, signedTx: Transaction | FeeBumpTransaction) => void | Promise<void>;
}

export function validateReviewMatch(original: ReviewSnapshot, current: ReviewSnapshot): boolean {
  if (
    original.account !== current.account ||
    original.recipient.trim().toLowerCase() !== current.recipient.trim().toLowerCase() ||
    original.destination !== current.destination ||
    original.route !== current.route ||
    original.bridgeAmount !== current.bridgeAmount ||
    original.stage !== current.stage
  ) {
    return false;
  }
  if (original.sourceId !== undefined && original.sourceId !== current.sourceId) {
    return false;
  }
  if (original.sourceAmount !== undefined && original.sourceAmount !== current.sourceAmount) {
    return false;
  }
  if (
    original.resourceFee !== undefined &&
    current.resourceFee !== undefined &&
    original.resourceFee !== current.resourceFee
  ) {
    return false;
  }
  if (
    original.networkFee !== undefined &&
    current.networkFee !== undefined &&
    original.networkFee !== current.networkFee
  ) {
    return false;
  }
  return true;
}

export function reconcileSignatureReturn(
  original: ReviewSnapshot,
  current: ReviewSnapshot | null,
  currentAccount: string | null,
  hash: string,
): { valid: true } | { valid: false; reason: "superseded" | "account_switch" } {
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
    return { valid: false, reason: "superseded" };
  }
  if (!current || !validateReviewMatch(original, current)) {
    return { valid: false, reason: "superseded" };
  }
  if (currentAccount !== original.account) {
    return { valid: false, reason: "account_switch" };
  }
  return { valid: true };
}

export interface SequenceDiagnostic {
  valid: boolean;
  expectedSequence: string;
  ledgerSequence: string;
  reason: string | null;
}

export function diagnoseSequence(
  constructedSequence: string,
  ledgerSequence: string,
): SequenceDiagnostic {
  const expectedLedgerSequence = (BigInt(constructedSequence) - 1n).toString();
  if (ledgerSequence !== expectedLedgerSequence) {
    return {
      valid: false,
      expectedSequence: expectedLedgerSequence,
      ledgerSequence,
      reason: `The account sequence changed from ${expectedLedgerSequence} to ${ledgerSequence} after construction. Review a fresh simulation before signing.`,
    };
  }
  return {
    valid: true,
    expectedSequence: expectedLedgerSequence,
    ledgerSequence,
    reason: null,
  };
}

export async function verifyAccountSequence(
  client: rpc.Server,
  accountAddress: string,
  constructedSequence: string,
): Promise<void> {
  const latest = await client.getAccount(accountAddress);
  const diagnostic = diagnoseSequence(constructedSequence, latest.sequenceNumber());
  if (!diagnostic.valid) {
    throw new Error(diagnostic.reason ?? "The account sequence changed after construction.");
  }
}

export interface SimulatedOperation {
  resourceFee: bigint;
  networkFee: bigint;
  totalFee: bigint;
  preparedTransaction: Transaction;
  envelopeXdr: string;
  sequence: string;
}

export function validateEnvelopeOperation(
  expectedOperation: xdr.Operation,
  preparedTransaction: Transaction,
): boolean {
  const envelope = preparedTransaction.toEnvelope();
  if (envelope.type !== "envelopeTypeTx" || envelope.v1.tx.operations.length !== 1) return false;
  const actual = envelope.v1.tx.operations[0];
  if (
    !actual ||
    expectedOperation.body.type !== "invokeHostFunction" ||
    actual.body.type !== "invokeHostFunction"
  )
    return false;
  // Assembly adds the authorization entries returned by simulation. The reviewed call
  // and operation source must stay identical; the full assembled envelope is frozen separately.
  return (
    actual.body.invokeHostFunctionOp.hostFunction.toXdr("base64") ===
      expectedOperation.body.invokeHostFunctionOp.hostFunction.toXdr("base64") &&
    actual.sourceAccount?.toXdr("base64") === expectedOperation.sourceAccount?.toXdr("base64")
  );
}

export async function simulateOperation(
  sender: string,
  operation: xdr.Operation,
): Promise<SimulatedOperation> {
  const client = server();
  const network = await client.getNetwork();
  if (network.passphrase !== TESTNET.networkPassphrase)
    throw new Error("The RPC endpoint is not Stellar Testnet.");
  const account = await client.getAccount(sender);
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: TESTNET.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(TRANSACTION_TIMEOUT_SECONDS)
    .build();
  const simulation = await submissionStage("simulation", () =>
    client.simulateTransaction(transaction),
  );
  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw classifySubmissionFailure(
      "simulation",
      rpc.Api.isSimulationError(simulation)
        ? simulation.error
        : "Contract state needs restoration. Ask the operator to restore it.",
    );
  }
  const prepared = await submissionStage("simulation", () =>
    rpc.assembleTransaction(transaction, simulation).build(),
  );
  const envelope = prepared.toEnvelope();
  if (envelope.type !== "envelopeTypeTx" || envelope.v1.tx.ext.type !== "sorobanData")
    throw new Error("The simulation did not assemble a Soroban envelope.");
  const resourceFee = envelope.v1.tx.ext.sorobanData.resourceFee;
  const totalFee = BigInt(prepared.fee);
  const networkFee = totalFee - resourceFee;
  if (networkFee < 0n) throw new Error("Invalid simulation fee data. Refresh the simulation.");
  return {
    resourceFee,
    networkFee,
    totalFee,
    preparedTransaction: prepared,
    envelopeXdr: prepared.toXdr(),
    sequence: prepared.sequence,
  };
}

export async function simulateBridgeOut(
  sender: string,
  quoted: LiveQuote,
  recipient: string,
): Promise<SimulatedOperation> {
  validateRecipient(recipient);
  const operation = bridgeOperation(sender, quoted, recipient);
  return simulateOperation(sender, operation);
}

export async function submitOperation(
  sender: string,
  operation: xdr.Operation,
  sign: WalletSigner,
  progress?: (phase: TransactionPhase, hash?: string) => void,
  approval?: WalletApprovalProvenance,
  reconcile?: SubmissionReconciliation,
  simulated?: SimulatedOperation,
  signal?: AbortSignal,
): Promise<TransactionResult> {
  const prepared = await submissionStage("build", async () => {
    const client = server();
    progress?.("preparing");
    const network = await client.getNetwork();
    if (network.passphrase !== TESTNET.networkPassphrase)
      throw new Error("The RPC endpoint is not Stellar Testnet.");
    let prepared: Transaction;
    if (simulated) {
      if (!validateEnvelopeOperation(operation, simulated.preparedTransaction)) {
        throw new Error(
          "Displayed operation does not correspond to the envelope sent to the wallet.",
        );
      }
      prepared = simulated.preparedTransaction;
      const envelope = prepared.toEnvelope();
      if (
        envelope.type !== "envelopeTypeTx" ||
        envelope.v1.tx.ext.type !== "sorobanData" ||
        simulated.totalFee !== BigInt(prepared.fee) ||
        simulated.resourceFee !== envelope.v1.tx.ext.sorobanData.resourceFee ||
        simulated.networkFee !== simulated.totalFee - simulated.resourceFee
      )
        throw new Error(
          "The displayed simulation fees changed. Review a fresh simulation before signing.",
        );
      if (
        prepared.source !== sender ||
        prepared.toXdr() !== simulated.envelopeXdr ||
        prepared.sequence !== simulated.sequence
      )
        throw new Error(
          "The reviewed simulation changed. Review a fresh simulation before signing.",
        );
    } else {
      const sim = await simulateOperation(sender, operation);
      prepared = sim.preparedTransaction;
    }
    await verifyAccountSequence(client, sender, prepared.sequence);
    progress?.("signing");
    return prepared;
  });
  return signAndSubmit(prepared, sign, progress, approval, reconcile, signal);
}

export async function submitClassicOperations(
  sender: string,
  operations: readonly xdr.Operation[] | (() => Promise<readonly xdr.Operation[]>),
  sign: WalletSigner,
  progress?: (phase: TransactionPhase, hash?: string) => void,
  approval?: WalletApprovalProvenance,
  reconcile?: SubmissionReconciliation,
  signal?: AbortSignal,
): Promise<TransactionResult> {
  const prepared = await submissionStage("build", async () => {
    const client = server();
    if ((await client.getNetwork()).passphrase !== TESTNET.networkPassphrase)
      throw new Error("The RPC endpoint is not Stellar Testnet.");
    const account = await client.getAccount(sender);
    const builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: TESTNET.networkPassphrase,
    });
    const preparedOperations = typeof operations === "function" ? await operations() : operations;
    for (const operation of preparedOperations) builder.addOperation(operation);
    return builder.setTimeout(TRANSACTION_TIMEOUT_SECONDS).build();
  });
  return signAndSubmit(prepared, sign, progress, approval, reconcile, signal);
}

async function signAndSubmit(
  prepared: Transaction,
  sign: WalletSigner,
  progress?: (phase: TransactionPhase, hash?: string) => void,
  approval?: WalletApprovalProvenance,
  reconcile?: SubmissionReconciliation,
  signal?: AbortSignal,
): Promise<TransactionResult> {
  const client = server();
  const signedTransaction = await submissionStage("approval", async () => {
    progress?.("signing");
    if (transactionDeadline(prepared).notYetValid)
      throw new Error("The transaction envelope is not yet valid. Review a fresh transaction.");
    if (transactionDeadline(prepared).expired)
      throw new Error("The signed transaction envelope has expired. Review again.");
    const signOptions = { networkPassphrase: TESTNET.networkPassphrase };
    let signed: Awaited<ReturnType<WalletSigner>>;
    try {
      signed = await sign(prepared.toXdr(), approval ? { ...signOptions, approval } : signOptions);
    } catch (error) {
      throw classifySubmissionFailure("approval", error);
    }
    const signedTransaction = TransactionBuilder.fromXdr(
      signed.signedTxXdr,
      TESTNET.networkPassphrase,
    );
    if (toHex(signedTransaction.hash()) !== toHex(prepared.hash())) {
      throw classifySubmissionFailure(
        "approval",
        "The wallet returned a different transaction. Nothing was submitted.",
      );
    }
    if (
      "innerTransaction" in signedTransaction ||
      signedTransaction.sequence !== prepared.sequence
    ) {
      throw new Error(
        "The transaction sequence was modified. Stale sequence cannot be silently changed inside a reviewed signed envelope.",
      );
    }
    if (transactionDeadline(signedTransaction).notYetValid)
      throw new Error("The transaction envelope is not yet valid. Nothing was submitted.");
    if (transactionDeadline(signedTransaction).expired)
      throw new Error(
        "The signed transaction envelope expired before broadcast. Nothing was submitted.",
      );
    return signedTransaction;
  });
  const hash = toHex(prepared.hash()).slice(2);
  await submissionStage("checkpoint", async () => {
    if (reconcile) {
      if (reconcile.isSuperseded?.()) {
        throw new Error(
          "The review was superseded before signing completed. Nothing was submitted.",
        );
      }
      const currentAccount = reconcile.getCurrentAccount
        ? reconcile.getCurrentAccount()
        : reconcile.expectedAccount;
      if (currentAccount !== reconcile.expectedAccount) {
        if (reconcile.onAccountSwitch) {
          await reconcile.onAccountSwitch(hash, signedTransaction);
        }
        throw new Error(
          "Wallet account switched. The transaction was preserved in recovery and not submitted.",
        );
      }
      if (reconcile.validate) {
        await reconcile.validate(hash, signedTransaction);
      }
    }
    progress?.("submitting", hash);
  });
  try {
    const submitted = await client.sendTransaction(signedTransaction);
    if (submitted.status === "ERROR")
      throw classifySubmissionFailure(
        "broadcast",
        "The network rejected the signed transaction. Refresh the quote and try again.",
        hash,
      );
    if (submitted.status === "TRY_AGAIN_LATER")
      throw classifySubmissionFailure(
        "broadcast",
        "The network is busy. Nothing was accepted; please try again.",
        hash,
      );
  } catch (error) {
    if (error instanceof SubmissionFailure) throw error;
    // A network timeout after submission has an unknown outcome. Preserve the real hash for checking.
    return {
      status: "pending",
      txHash: hash,
      failure: classifySubmissionFailure("broadcast", error, hash),
    };
  }
  progress?.("pending", hash);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (signal?.aborted) return { status: "pending", txHash: hash };
    await confirmationDelay(2000, signal);
    if (signal?.aborted) return { status: "pending", txHash: hash };
    let result: TransactionResult | null;
    try {
      result = await readTransaction(hash, signal);
    } catch (error) {
      return {
        status: "pending",
        txHash: hash,
        failure: classifySubmissionFailure("confirmation", error, hash),
      };
    }
    if (signal?.aborted) return { status: "pending", txHash: hash };
    if (result && result.status !== "pending") {
      if (result.status === "confirmed") progress?.("confirmed", hash);
      return result;
    }
  }
  return { status: "pending", txHash: hash };
}

export async function submitBridgeOut(
  sender: string,
  quoted: LiveQuote,
  recipient: string,
  sign: WalletSigner,
  progress?: (phase: TransactionPhase, hash?: string) => void,
  approval?: WalletApprovalProvenance,
  reconcile?: SubmissionReconciliation,
  simulated?: SimulatedOperation,
  signal?: AbortSignal,
): Promise<TransactionResult> {
  validateRecipient(recipient);
  const refreshed = await quoteTransfer(
    quoted.destination,
    quoted.requestedAmount,
    quoted.route as BridgeRoute,
  );
  if (
    refreshed.grossAmount !== quoted.grossAmount ||
    refreshed.destinationAmount < quoted.destinationAmount ||
    refreshed.fee !== quoted.fee ||
    (refreshed.estimatedRelayGas ?? refreshed.relayGas) > quoted.relayGas
  ) {
    throw new Error("The quote changed. Review a fresh quote before signing.");
  }
  const balance = await readBalance(sender);
  if (balance < refreshed.grossAmount)
    throw new Error(`Insufficient testnet USDC. Your balance is ${formatUnits(balance, 7)} USDC.`);
  return submitOperation(
    sender,
    bridgeOperation(sender, quoted, recipient),
    sign,
    progress,
    approval,
    reconcile,
    simulated,
    signal,
  );
}

export async function getClaim(id: bigint): Promise<PendingClaim> {
  if (id <= 0n || id > (1n << 64n) - 1n) throw new Error("Enter a valid claim number.");
  const deployment = await verifyRouterDeployment();
  const result = object(
    (await view(TESTNET.router, "get_claim", [nativeToScVal(id, { type: "u64" })])).value,
  );
  return {
    id: integer(result.id),
    recipient: address(result.recipient),
    token: address(result.token),
    amount: integer(result.amount),
    settled: result.settled === true,
    eligibility: await claimPayoutEligibility(id, address(result.token)),
    deployment,
  };
}

export async function getClaims(ids: readonly bigint[]): Promise<PendingClaim[]> {
  if (ids.length === 0) throw new Error("Enter at least one claim number.");
  if (ids.length > MAX_BATCH_CLAIMS)
    throw new Error(`Review at most ${MAX_BATCH_CLAIMS} claims at a time.`);
  const unique = new Set(ids.map(String));
  if (unique.size !== ids.length) throw new Error("Each claim number can appear only once.");
  return Promise.all(ids.map((id) => getClaim(id)));
}

export async function batchClaimSettlementSupport(): Promise<boolean> {
  await verifyRouterDeployment();
  const client = await ContractClient.from({
    contractId: TESTNET.router,
    rpcUrl: TESTNET.rpcUrl,
    networkPassphrase: TESTNET.networkPassphrase,
  });
  return supportsBatchClaimSettlement(client.spec.funcs());
}

export function settleClaimsOperation(sender: string, ids: readonly bigint[]) {
  if (ids.length < 2 || ids.length > MAX_BATCH_CLAIMS)
    throw new Error(`Batch settlement requires two to ${MAX_BATCH_CLAIMS} claims.`);
  if (
    new Set(ids.map(String)).size !== ids.length ||
    ids.some((id) => id <= 0n || id > (1n << 64n) - 1n)
  )
    throw new Error("Use distinct valid claim numbers.");
  return new Contract(TESTNET.router).call(
    "settle_claims",
    new Address(sender).toScVal(),
    nativeToScVal([...ids], { type: "u64" }),
  );
}

export async function submitSettleClaim(
  sender: string,
  id: bigint,
  sign: WalletSigner,
  approval?: WalletApprovalProvenance,
  reconcile?: SubmissionReconciliation,
  signal?: AbortSignal,
): Promise<TransactionResult> {
  const claim = await getClaim(id);
  if (claim.settled) throw new Error("This claim is already settled.");
  if (claim.eligibility.status === "ineligible")
    throw new Error(`Claim payout is ineligible: ${claim.eligibility.reason}`);
  const deployment = await verifyRouterDeployment();
  if (deployment.wasmHash !== claim.deployment.wasmHash)
    throw new Error(
      "Claim recovery is read-only: the verified router changed. Look up the claim again.",
    );
  return submitOperation(
    sender,
    new Contract(TESTNET.router).call(
      "settle_claim",
      new Address(sender).toScVal(),
      nativeToScVal(id, { type: "u64" }),
    ),
    sign,
    undefined,
    approval,
    reconcile,
    undefined,
    signal,
  );
}

export async function submitSettleClaims(
  sender: string,
  claims: readonly PendingClaim[],
  sign: WalletSigner,
  approval?: WalletApprovalProvenance,
  reconcile?: SubmissionReconciliation,
  signal?: AbortSignal,
): Promise<TransactionResult> {
  if (claims.length < 2) throw new Error("Batch settlement requires at least two claims.");
  if (claims.length > MAX_BATCH_CLAIMS)
    throw new Error(`Review at most ${MAX_BATCH_CLAIMS} claims at a time.`);
  if (claims.some((claim) => claim.settled))
    throw new Error("Remove already settled claims before signing the batch.");
  const deployment = await verifyRouterDeployment();
  if (claims.some((claim) => claim.deployment.wasmHash !== deployment.wasmHash))
    throw new Error(
      "Claim recovery is read-only: the verified router changed. Look up the claims again.",
    );
  if (!(await batchClaimSettlementSupport()))
    throw new Error("This router supports single-claim settlement only.");
  const current = await getClaims(claims.map((claim) => claim.id));
  if (
    current.some((claim, index) => {
      const reviewed = claims[index];
      return (
        claim.eligibility.status === "ineligible" ||
        !reviewed ||
        claim.settled ||
        claim.recipient !== reviewed.recipient ||
        claim.token !== reviewed.token ||
        claim.amount !== reviewed.amount ||
        claim.deployment.router !== reviewed.deployment.router ||
        claim.deployment.chain !== reviewed.deployment.chain ||
        claim.deployment.wasmHash !== reviewed.deployment.wasmHash
      );
    })
  )
    throw new Error("The claims changed. Review them again before signing.");
  return submitOperation(
    sender,
    settleClaimsOperation(
      sender,
      claims.map((claim) => claim.id),
    ),
    sign,
    undefined,
    approval,
    reconcile,
    undefined,
    signal,
  );
}

function confirmationDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

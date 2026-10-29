import { createPublicClient, http, parseAbi } from "viem";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
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
  CIRCLE_STELLAR,
  destinationFor,
  destinationDecimals,
  type BridgeRoute,
  type DestinationKey,
} from "../config/testnet";

const ITS_ROUTE = 1;
const I128_MAX = (1n << 127n) - 1n;

export type WalletSigner = (
  xdr: string,
  opts: { networkPassphrase: string },
) => Promise<{ signedTxXdr: string }>;
export type TransactionPhase = "preparing" | "signing" | "submitting" | "pending" | "confirmed";
export interface TransactionResult {
  status: "confirmed" | "pending" | "failed";
  txHash: string;
  nonce?: string;
}
export interface LiveQuote {
  route: number;
  grossAmount: bigint;
  fee: bigint;
  netAmount: bigint;
  destinationAmount: bigint;
  flowAvailable: bigint;
  ledger: number;
  adapter: string;
  destination: DestinationKey;
  requestedAmount: bigint;
  relayGas: bigint;
  estimatedRelayGas?: bigint;
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
}

function server() {
  return new rpc.Server(TESTNET.rpcUrl, { timeout: 15_000 });
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
  const message = error instanceof Error ? error.message : String(error);
  const code = /Error\(Contract, #(\d+)\)/.exec(message)?.[1];
  if (code) {
    const name = sorobanErrorName(Number(code));
    if (name) return `${name}: ${describeError(name).summary}`;
  }
  return message.split("\n")[0] ?? "The network request failed. Please try again.";
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
  if (route === 1 && destinationKey !== "sepolia")
    return {
      available: false,
      reason: "Axelar ITS is configured for Sepolia. Choose Circle CCTP for this network.",
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
      transport: http(destination.rpcUrl, { timeout: 15000, retryCount: 0 }),
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
      transport: http(destination.rpcUrl, { timeout: 15_000, retryCount: 0 }),
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
  const fee: unknown = await feeResponse.json();
  const relayGas = integer(object(fee).amount);
  const estimatedRelayGas = integer(object(fee).estimatedAmount ?? relayGas);
  if (estimatedRelayGas <= 0n || estimatedRelayGas > relayGas)
    throw new Error("Invalid live fee estimate.");
  if (relayGas <= 0n || relayGas > I128_MAX) throw new Error("Invalid relay gas estimate.");
  if (route === 0 && (relayGas % 10n !== 0n || relayGas >= integer(quote.net_amount)))
    throw new Error("Increase the amount to cover Circle's destination forwarding fee.");
  return {
    relayGas,
    estimatedRelayGas,
    route,
    adapter: lane.adapter,
    destination: destinationKey,
    requestedAmount: amount,
    grossAmount: integer(quote.gross_amount),
    fee: integer(quote.fee),
    netAmount: integer(quote.net_amount),
    destinationAmount: integer(quote.destination_amount) - (route === 0 ? relayGas / 10n : 0n),
    flowAvailable: integer(quote.flow_available),
    ledger: response.ledger,
  };
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

export async function readTransaction(hash: string): Promise<TransactionResult | null> {
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) return null;
  const result = await server().getTransaction(hash);
  if (result.status === rpc.Api.GetTransactionStatus.FAILED)
    return { status: "failed", txHash: hash };
  if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    const value: unknown = result.returnValue ? scValToNative(result.returnValue) : undefined;
    return {
      status: "confirmed",
      txHash: hash,
      ...(typeof value === "bigint" ? { nonce: String(value) } : {}),
    };
  }
  return { status: "pending", txHash: hash };
}

async function submitOperation(
  sender: string,
  operation: xdr.Operation,
  sign: WalletSigner,
  progress?: (phase: TransactionPhase, hash?: string) => void,
): Promise<TransactionResult> {
  const client = server();
  progress?.("preparing");
  const network = await client.getNetwork();
  if (network.passphrase !== TESTNET.networkPassphrase)
    throw new Error("The RPC endpoint is not Stellar Testnet.");
  const account = await client.getAccount(sender);
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: TESTNET.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(180)
    .build();
  const simulation = await client.simulateTransaction(transaction);
  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw new Error(
      rpc.Api.isSimulationError(simulation)
        ? simulation.error
        : "Contract state needs restoration. Ask the operator to restore it.",
    );
  }
  const prepared = rpc.assembleTransaction(transaction, simulation).build();
  progress?.("signing");
  return signAndSubmit(prepared, sign, progress);
}

export async function submitClassicOperations(
  sender: string,
  operations: readonly xdr.Operation[],
  sign: WalletSigner,
  progress?: (phase: TransactionPhase, hash?: string) => void,
): Promise<TransactionResult> {
  const client = server();
  if ((await client.getNetwork()).passphrase !== TESTNET.networkPassphrase)
    throw new Error("The RPC endpoint is not Stellar Testnet.");
  const builder = new TransactionBuilder(await client.getAccount(sender), {
    fee: BASE_FEE,
    networkPassphrase: TESTNET.networkPassphrase,
  });
  for (const operation of operations) builder.addOperation(operation);
  return signAndSubmit(builder.setTimeout(180).build(), sign, progress);
}

async function signAndSubmit(
  prepared: Transaction,
  sign: WalletSigner,
  progress?: (phase: TransactionPhase, hash?: string) => void,
): Promise<TransactionResult> {
  const client = server();
  progress?.("signing");
  const signed = await sign(prepared.toXdr(), {
    networkPassphrase: TESTNET.networkPassphrase,
  });
  const signedTransaction = TransactionBuilder.fromXdr(
    signed.signedTxXdr,
    TESTNET.networkPassphrase,
  );
  if (toHex(signedTransaction.hash()) !== toHex(prepared.hash())) {
    throw new Error("The wallet returned a different transaction. Nothing was submitted.");
  }
  const hash = toHex(prepared.hash()).slice(2);
  progress?.("submitting", hash);
  try {
    const submitted = await client.sendTransaction(signedTransaction);
    if (submitted.status === "ERROR")
      throw new Error(
        "The network rejected the signed transaction. Refresh the quote and try again.",
      );
    if (submitted.status === "TRY_AGAIN_LATER")
      throw new Error("The network is busy. Nothing was accepted; please try again.");
  } catch (error) {
    if (error instanceof Error && /network rejected|Nothing was accepted/.test(error.message))
      throw error;
    // A network timeout after submission has an unknown outcome. Preserve the real hash for checking.
    return { status: "pending", txHash: hash };
  }
  progress?.("pending", hash);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    let result: TransactionResult | null;
    try {
      result = await readTransaction(hash);
    } catch {
      return { status: "pending", txHash: hash };
    }
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
  return submitOperation(sender, bridgeOperation(sender, quoted, recipient), sign, progress);
}

export async function getClaim(id: bigint): Promise<PendingClaim> {
  if (id <= 0n || id > (1n << 64n) - 1n) throw new Error("Enter a valid claim number.");
  const result = object(
    (await view(TESTNET.router, "get_claim", [nativeToScVal(id, { type: "u64" })])).value,
  );
  return {
    id: integer(result.id),
    recipient: address(result.recipient),
    token: address(result.token),
    amount: integer(result.amount),
    settled: result.settled === true,
  };
}

export async function submitSettleClaim(
  sender: string,
  id: bigint,
  sign: WalletSigner,
): Promise<TransactionResult> {
  const claim = await getClaim(id);
  if (claim.settled) throw new Error("This claim is already settled.");
  return submitOperation(
    sender,
    new Contract(TESTNET.router).call(
      "settle_claim",
      new Address(sender).toScVal(),
      nativeToScVal(id, { type: "u64" }),
    ),
    sign,
  );
}

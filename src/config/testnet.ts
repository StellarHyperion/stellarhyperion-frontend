import { CHAINS, RAIL_CONTRACTS, assetOn } from "@hyperion/protocol";
import deployment from "./testnet-deployment.json";
import { StrKey } from "@stellar/stellar-sdk";
const configured = (value: string | undefined, fallback: string) =>
  value?.trim() ? value.trim() : fallback;
const stellar = deployment.networks["stellar-testnet"];
export interface PublicDeploymentIdentity {
  readonly recordedAt: string;
  readonly chain: "stellar-testnet";
  readonly router: string;
  readonly token: string;
  readonly wasmHash: string;
  readonly commit: string;
  readonly deployedLedger: number;
}
export const DEPLOYMENT_IDENTITY: PublicDeploymentIdentity = {
  recordedAt: deployment.generatedAt,
  chain: "stellar-testnet",
  router: stellar.router,
  token: stellar.tokens.USDC.sacId,
  wasmHash: stellar.wasmHashes.router,
  commit: stellar.commit,
  deployedLedger: stellar.deployedAt.ledger,
};
export function parsePublicDeploymentIdentity(value: unknown): PublicDeploymentIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const identity = value as Record<string, unknown>;
  if (
    typeof identity.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(identity.recordedAt)) ||
    identity.chain !== "stellar-testnet" ||
    typeof identity.router !== "string" ||
    !StrKey.isValidContract(identity.router) ||
    typeof identity.token !== "string" ||
    !StrKey.isValidContract(identity.token) ||
    typeof identity.wasmHash !== "string" ||
    !/^[0-9a-f]{64}$/i.test(identity.wasmHash) ||
    typeof identity.commit !== "string" ||
    !/^[0-9a-f]{7,40}$/i.test(identity.commit) ||
    typeof identity.deployedLedger !== "number" ||
    !Number.isSafeInteger(identity.deployedLedger) ||
    identity.deployedLedger < 0
  )
    return null;
  return {
    recordedAt: identity.recordedAt,
    chain: identity.chain,
    router: identity.router,
    token: identity.token,
    wasmHash: identity.wasmHash,
    commit: identity.commit,
    deployedLedger: identity.deployedLedger,
  };
}
export function deploymentIdentityMatches(value: unknown): boolean {
  const observed = parsePublicDeploymentIdentity(value);
  return (
    observed !== null &&
    observed.recordedAt === DEPLOYMENT_IDENTITY.recordedAt &&
    observed.chain === DEPLOYMENT_IDENTITY.chain &&
    observed.router === DEPLOYMENT_IDENTITY.router &&
    observed.token === DEPLOYMENT_IDENTITY.token &&
    observed.wasmHash === DEPLOYMENT_IDENTITY.wasmHash &&
    observed.commit === DEPLOYMENT_IDENTITY.commit &&
    observed.deployedLedger === DEPLOYMENT_IDENTITY.deployedLedger
  );
}
export interface PublicAssetMetadata {
  readonly key: string;
  readonly network: string;
  readonly code: string;
  readonly issuer: string;
  readonly decimals: number;
  readonly deploymentCommit: string;
  readonly observedAt: string;
  readonly stale: boolean;
}
export interface AssetMetadataScope {
  readonly network: string;
  readonly deploymentCommit: string;
}
const ASSET_METADATA_TTL_MS = 5 * 60 * 1000;
const ASSET_METADATA_LIMIT = 64;
const ASSET_METADATA_PREFIX = "hyperion.asset-metadata.v2:";
const ASSET_METADATA_INDEX = ASSET_METADATA_PREFIX + "index";
const assetMetadataMemory = new Map<string, PublicAssetMetadata>();
const metadataScope: AssetMetadataScope = {
  network: "stellar-testnet",
  deploymentCommit: stellar.commit,
};
function assetMetadataKey(code: string, issuer: string, scope: AssetMetadataScope): string {
  if (
    !/^[A-Za-z0-9]{1,12}$/.test(code) ||
    !StrKey.isValidEd25519PublicKey(issuer) ||
    !scope.network ||
    scope.network.length > 128 ||
    !/^[0-9a-f]{7,40}$/i.test(scope.deploymentCommit)
  )
    throw new Error("Invalid public asset metadata identity.");
  return (
    ASSET_METADATA_PREFIX +
    [scope.network, scope.deploymentCommit, code, issuer].map(encodeURIComponent).join(":")
  );
}
function metadataIndex(): string[] {
  const raw = localStorage.getItem(ASSET_METADATA_INDEX);
  if (!raw || raw.length > 32768) return [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed)
    ? parsed
        .filter(
          (value): value is string =>
            typeof value === "string" &&
            value.startsWith(ASSET_METADATA_PREFIX) &&
            value !== ASSET_METADATA_INDEX &&
            value.length <= 512,
        )
        .slice(-ASSET_METADATA_LIMIT)
    : [];
}
function rememberMetadata(metadata: PublicAssetMetadata): void {
  assetMetadataMemory.delete(metadata.key);
  assetMetadataMemory.set(metadata.key, metadata);
  if (assetMetadataMemory.size > ASSET_METADATA_LIMIT) {
    const oldest = assetMetadataMemory.keys().next().value;
    if (oldest !== undefined) assetMetadataMemory.delete(oldest);
  }
  try {
    const index = metadataIndex().filter((key) => key !== metadata.key);
    while (index.length >= ASSET_METADATA_LIMIT) {
      const oldest = index.shift();
      if (oldest !== undefined) localStorage.removeItem(oldest);
    }
    index.push(metadata.key);
    localStorage.setItem(metadata.key, JSON.stringify(metadata));
    localStorage.setItem(ASSET_METADATA_INDEX, JSON.stringify(index));
  } catch {
    // Public metadata remains available without persistence; recovery storage is separate.
  }
}
export const TESTNET = {
  router: configured(process.env.NEXT_PUBLIC_STELLAR_ROUTER, stellar.router),
  token: configured(process.env.NEXT_PUBLIC_STELLAR_USDC, stellar.tokens.USDC.sacId),
  reader: stellar.admin,
  usdcCode: stellar.tokens.USDC.code,
  usdcIssuer: stellar.tokens.USDC.issuer,
  rpcUrl: configured(
    process.env.NEXT_PUBLIC_STELLAR_RPC_URL,
    "https://soroban-testnet.stellar.org",
  ),
  networkPassphrase: "Test SDF Network ; September 2015",
  horizonUrl: configured(
    process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL,
    "https://horizon-testnet.stellar.org",
  ),
} as const;
export const STELLAR_DEPLOYMENT = {
  chain: "stellar-testnet",
  router: stellar.router,
  usdcToken: stellar.tokens.USDC.sacId,
  usdcCode: stellar.tokens.USDC.code,
  usdcIssuer: stellar.tokens.USDC.issuer,
  networkPassphrase: stellar.networkPassphrase,
  wasmHash: stellar.wasmHashes.router,
  commit: stellar.commit,
  deployedLedger: stellar.deployedAt.ledger,
} as const;

export interface PublicConfigurationAdmission {
  readonly available: boolean;
  readonly reasons: readonly string[];
}

/**
 * Validate public deployment inputs before enabling money-like interactions.
 * The result contains labels only; it never echoes environment values or secrets.
 */
export interface PublicConfigurationInputs {
  networkPassphrase: string;
  router: string;
  token: string;
  rpcUrl: string;
  horizonUrl: string;
  apiUrl?: string;
  indexerUrl?: string;
}

function cleanPublicUrl(value: string, localHttp = false): boolean {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" || (localHttp && local && url.protocol === "http:"))
    );
  } catch {
    return false;
  }
}

export function validatePublicConfiguration(
  inputs: PublicConfigurationInputs,
): PublicConfigurationAdmission {
  const reasons: string[] = [];
  if (
    inputs.networkPassphrase !== "Test SDF Network ; September 2015" ||
    STELLAR_DEPLOYMENT.networkPassphrase !== "Test SDF Network ; September 2015"
  )
    reasons.push("The configured Stellar network is not the supported testnet.");
  if (inputs.router !== STELLAR_DEPLOYMENT.router || !StrKey.isValidContract(inputs.router))
    reasons.push("The configured router does not match the published testnet deployment.");
  if (inputs.token !== stellar.tokens.USDC.sacId || !StrKey.isValidContract(inputs.token))
    reasons.push("The configured token does not match the published testnet token.");
  if (!cleanPublicUrl(inputs.rpcUrl))
    reasons.push("The configured RPC endpoint needs a valid HTTPS URL without credentials.");
  if (!cleanPublicUrl(inputs.horizonUrl))
    reasons.push("The configured Horizon endpoint needs a valid HTTPS URL without credentials.");
  for (const origin of [inputs.apiUrl, inputs.indexerUrl])
    if (origin?.trim() && !cleanPublicUrl(origin.trim(), true)) {
      reasons.push(
        "The configured activity API origin is invalid. Use HTTPS or a local development origin without credentials.",
      );
      break;
    }
  return { available: reasons.length === 0, reasons };
}

export function publicConfigurationAdmission(): PublicConfigurationAdmission {
  return validatePublicConfiguration({
    ...TESTNET,
    apiUrl: process.env.NEXT_PUBLIC_HYPERION_API_URL ?? "",
    indexerUrl: process.env.NEXT_PUBLIC_HYPERION_INDEXER_URL ?? "",
  });
}
export function deploymentIdentityMismatch(router: string, token: string): string | null {
  if (router !== STELLAR_DEPLOYMENT.router)
    return "The configured Stellar router does not match the verified testnet deployment.";
  if (token !== STELLAR_DEPLOYMENT.usdcToken)
    return "The configured Stellar USDC token contract does not match the verified testnet deployment.";
  return null;
}

export interface ObservedDeploymentRevision {
  readonly commit?: string;
  readonly deploymentCommit?: string;
  readonly router?: string;
}

function observedCommit(value: string | ObservedDeploymentRevision): string {
  if (typeof value === "string") return value.trim();
  return (value.commit ?? value.deploymentCommit ?? "").trim();
}

export function deploymentRevisionMismatch(
  observed: string | ObservedDeploymentRevision,
): string | null {
  const commit = observedCommit(observed);
  if (!commit) return null;
  if (commit !== STELLAR_DEPLOYMENT.commit)
    return "The app deployment revision differs from the active configuration. Refresh to use the current deployment.";
  const router = typeof observed === "string" ? undefined : observed.router?.trim();
  if (router && router !== STELLAR_DEPLOYMENT.router)
    return "The active Stellar router differs from this app deployment. Refresh to use the current deployment.";
  return null;
}

export const deploymentRevisionChanged = (observed: string | ObservedDeploymentRevision): boolean =>
  deploymentRevisionMismatch(observed) !== null;

export const hasDeploymentRevisionChanged = deploymentRevisionChanged;
export const isDeploymentRevisionChanged = deploymentRevisionChanged;
export const deploymentRevisionNotice = deploymentRevisionMismatch;
export const deploymentNotice = deploymentRevisionMismatch;

export function getPublicAssetMetadata(
  code: string,
  issuer: string,
  now = Date.now(),
  scope: AssetMetadataScope = metadataScope,
): PublicAssetMetadata {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000)
    throw new Error("Invalid asset metadata observation time.");
  const key = assetMetadataKey(code, issuer, scope);
  const cached = readCachedAssetMetadata(code, issuer, now, scope);
  if (cached && !cached.stale) return cached;
  const fresh: PublicAssetMetadata = {
    key,
    network: scope.network,
    code,
    issuer,
    decimals: 7,
    deploymentCommit: scope.deploymentCommit,
    observedAt: new Date(now).toISOString(),
    stale: false,
  };
  rememberMetadata(fresh);
  return fresh;
}

export function readCachedAssetMetadata(
  code: string,
  issuer: string,
  now = Date.now(),
  scope: AssetMetadataScope = metadataScope,
): PublicAssetMetadata | null {
  const key = assetMetadataKey(code, issuer, scope);
  let cached: unknown = assetMetadataMemory.get(key);
  if (!cached) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw || raw.length > 1024) return null;
      cached = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!cached || typeof cached !== "object" || Array.isArray(cached)) return null;
  const value = cached as Record<string, unknown>;
  const observed = typeof value.observedAt === "string" ? Date.parse(value.observedAt) : NaN;
  if (
    value.key !== key ||
    value.network !== scope.network ||
    value.code !== code ||
    value.issuer !== issuer ||
    value.deploymentCommit !== scope.deploymentCommit ||
    value.decimals !== 7 ||
    !Number.isSafeInteger(now) ||
    !Number.isFinite(observed) ||
    observed > now
  )
    return null;
  return {
    key,
    network: scope.network,
    code,
    issuer,
    decimals: 7,
    deploymentCommit: scope.deploymentCommit,
    observedAt: String(value.observedAt),
    stale: now - observed > ASSET_METADATA_TTL_MS,
  };
}

export function cachedPublicAssetMetadata(query: string, now = Date.now()): PublicAssetMetadata[] {
  const keys = new Set(assetMetadataMemory.keys());
  try {
    for (const key of metadataIndex()) keys.add(key);
  } catch {
    /* Memory reads remain safe. */
  }
  const matches: PublicAssetMetadata[] = [];
  for (const key of keys) {
    const parts = key.slice(ASSET_METADATA_PREFIX.length).split(":");
    if (parts.length !== 4) continue;
    try {
      const [network, commit, code, issuer] = parts.map(decodeURIComponent);
      if (
        network !== metadataScope.network ||
        commit !== metadataScope.deploymentCommit ||
        !code ||
        !issuer ||
        (code !== query && issuer !== query)
      )
        continue;
      const metadata = readCachedAssetMetadata(code, issuer, now);
      if (metadata) matches.push(metadata);
    } catch {
      /* Malformed metadata never changes transfer configuration. */
    }
    if (matches.length >= 40) break;
  }
  return matches;
}
export interface ArchivedRouterDeployment {
  chain: "stellar-testnet";
  router: string;
  networkPassphrase: string;
  wasmHash: string;
  commit: string;
  deployedLedger: number;
  successor: {
    router: string;
    wasmHash: string;
    commit: string;
    deployedLedger: number;
  };
}
export const ARCHIVED_STELLAR_DEPLOYMENTS: readonly ArchivedRouterDeployment[] =
  stellar.archivedDeployments.map((archived) => ({
    chain: "stellar-testnet",
    router: archived.router,
    networkPassphrase: stellar.networkPassphrase,
    wasmHash: archived.wasmHash,
    commit: archived.commit,
    deployedLedger: archived.deployedAt.ledger,
    successor: archived.successor,
  }));
export function archivedRouterFor(router: string): ArchivedRouterDeployment | null {
  return ARCHIVED_STELLAR_DEPLOYMENTS.find((deployment) => deployment.router === router) ?? null;
}
export type BridgeRoute = 0 | 1;
const cctpDestinations = new Set(
  stellar.activation.cctp.status === "active" &&
    stellar.activation.cctp.acceptance === "delivered" &&
    !!stellar.activation.cctp.verifiedAt
    ? stellar.activation.cctp.transfers
        .filter(
          (transfer) =>
            stellar.activation.cctp.destinations.includes(transfer.destination) &&
            /^[0-9a-f]{64}$/i.test(transfer.sourceHash) &&
            /^0x[0-9a-f]{64}$/i.test(transfer.destinationHash),
        )
        .map((transfer) => transfer.destination)
    : [],
);
const itsDestinations = new Set(
  stellar.activation.status === "active" &&
    stellar.activation.acceptance === "delivered" &&
    /^[0-9a-f]{64}$/i.test(stellar.activation.sourceHash) &&
    /^0x[0-9a-f]{64}$/i.test(stellar.activation.destinationHash)
    ? [stellar.peerChain]
    : [],
);
export const CIRCLE_STELLAR = {
  messenger: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
  transmitter: "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY",
} as const;
export const DESTINATIONS = (["sepolia", "base-sepolia", "arc-testnet"] as const).map((key) => {
  const chain = CHAINS[key];
  if (chain.family !== "evm") throw new Error("Expected an EVM testnet.");
  const asset = assetOn(key, "USDC");
  const contracts = RAIL_CONTRACTS[key];
  if (asset?.family !== "evm" || !contracts?.cctp || chain.cctpDomain === null)
    throw new Error("Missing native USDC configuration.");
  return {
    key,
    name: chain.name,
    axelarName: chain.axelarName,
    decimals: 7,
    chainId: chain.chainId,
    rpcUrl: chain.defaultRpcUrl,
    its: contracts.axelar?.interchainTokenService as `0x${string}`,
    routes: [
      ...(cctpDestinations.has(key) ? ([0] as const) : []),
      ...(itsDestinations.has(key) ? ([1] as const) : []),
    ],
    cctpDomain: chain.cctpDomain,
    usdc: asset.address,
    messenger: contracts.cctp.tokenMessengerV2,
    transmitter: contracts.cctp.messageTransmitterV2,
  };
});

function publicHttpUrl(endpoint: string): URL {
  if (endpoint.length > 2048) throw new Error("A public provider endpoint is too long.");
  const url = new URL(endpoint);
  const localDevelopmentEndpoint =
    process.env.NODE_ENV === "development" &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !localDevelopmentEndpoint) ||
    url.hostname.includes("*") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      "Public provider endpoints must be unauthenticated HTTPS URLs (HTTP is limited to localhost in development).",
    );
  }
  return url;
}

export function stellarTransactionReadUrls(
  configuration = process.env.NEXT_PUBLIC_STELLAR_READ_RPC_URLS ?? "",
): string[] {
  if (configuration.length > 4096)
    throw new Error("Stellar transaction read source configuration is too large.");
  const configured = configuration
    .split(",")
    .map((endpoint) => endpoint.trim())
    .filter(Boolean);
  const primary = publicHttpUrl(TESTNET.rpcUrl);
  const sources = [primary.toString()];
  const origins = new Set([primary.origin]);
  for (const endpoint of configured) {
    const url = publicHttpUrl(endpoint);
    if (origins.has(url.origin)) continue;
    if (sources.length >= 3)
      throw new Error("Stellar transaction read sources allow at most two additional origins.");
    origins.add(url.origin);
    sources.push(url.toString());
  }
  return sources;
}

function walletOrigins(): string[] {
  const origins = deployment.browserResources.walletOrigins;
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.hostname.includes("*") || url.origin !== origin)
      throw new Error("Wallet origins must be explicit HTTPS origins.");
  }
  return origins;
}

const indexerUrl =
  process.env.NEXT_PUBLIC_HYPERION_API_URL ?? process.env.NEXT_PUBLIC_HYPERION_INDEXER_URL ?? "";
const connectOrigins = new Set([
  ...stellarTransactionReadUrls().map((endpoint) => publicHttpUrl(endpoint).origin),
  publicHttpUrl(TESTNET.horizonUrl).origin,
  ...DESTINATIONS.map((destination) => publicHttpUrl(destination.rpcUrl).origin),
]);
if (indexerUrl.trim()) connectOrigins.add(publicHttpUrl(indexerUrl.trim()).origin);

export const BROWSER_RESOURCE_ORIGINS = {
  wallet: walletOrigins(),
  connect: [...connectOrigins],
} as const;

export const destinationDecimals = (route: number) => (route === 0 ? 6 : 7);
export type DestinationKey = (typeof DESTINATIONS)[number]["key"];
export function destinationFor(key: string) {
  const destination = DESTINATIONS.find((chain) => chain.key === key);
  if (!destination) throw new Error("Choose a supported destination testnet.");
  return destination;
}
export interface SupportedLane {
  route: BridgeRoute;
  provider: string;
}
const LANE_PROVIDERS: Record<BridgeRoute, string> = {
  0: "Circle CCTP",
  1: "Axelar ITS",
};
/**
 * Every rail this testnet deployment actually carries to a destination, independent of live
 * liquidity or pause state. Read straight off `destination.routes`, the same activation-derived
 * list `readLane` checks before ever asking the chain, so this can never drift from it or invent
 * a lane that isn't actually wired for this deployment.
 */
export function supportedLanes(key: DestinationKey): readonly SupportedLane[] {
  return destinationFor(key).routes.map((route) => ({ route, provider: LANE_PROVIDERS[route] }));
}

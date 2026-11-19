import { CHAINS, RAIL_CONTRACTS, assetOn } from "@hyperion/protocol";
import deployment from "./testnet-deployment.json";
import { StrKey } from "@stellar/stellar-sdk";
const configured = (value: string | undefined, fallback: string) =>
  value?.trim() ? value.trim() : fallback;
const stellar = deployment.networks["stellar-testnet"];
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
  horizonUrl: "https://horizon-testnet.stellar.org",
} as const;
export const STELLAR_DEPLOYMENT = {
  chain: "stellar-testnet",
  router: stellar.router,
  networkPassphrase: stellar.networkPassphrase,
  wasmHash: stellar.wasmHashes.router,
  commit: stellar.commit,
  deployedLedger: stellar.deployedAt.ledger,
} as const;

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
export type BridgeRoute = 0 | 1;
const cctpDestinations = new Set(
  stellar.activation.cctp.status === "active" && stellar.activation.cctp.acceptance === "delivered"
    ? stellar.activation.cctp.destinations
    : [],
);
const itsDestinations = new Set(
  stellar.activation.status === "active" && stellar.activation.acceptance === "delivered"
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
export const destinationDecimals = (route: number) => (route === 0 ? 6 : 7);
export type DestinationKey = (typeof DESTINATIONS)[number]["key"];
export function destinationFor(key: string) {
  const destination = DESTINATIONS.find((chain) => chain.key === key);
  if (!destination) throw new Error("Choose a supported destination testnet.");
  return destination;
}

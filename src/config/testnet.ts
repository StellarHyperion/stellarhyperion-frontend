import { CHAINS, RAIL_CONTRACTS, assetOn } from "@hyperion/protocol";
import deployment from "./testnet-deployment.json";
const configured = (value: string | undefined, fallback: string) =>
  value?.trim() ? value.trim() : fallback;
const stellar = deployment.networks["stellar-testnet"];
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
export const TESTNET_CONFIGURATION_FINGERPRINT = [
  TESTNET.router,
  TESTNET.token,
  TESTNET.networkPassphrase,
  TESTNET.usdcCode,
  TESTNET.usdcIssuer,
].join(":");
export const STELLAR_DEPLOYMENT = {
  chain: "stellar-testnet",
  router: stellar.router,
  networkPassphrase: stellar.networkPassphrase,
  wasmHash: stellar.wasmHashes.router,
  commit: stellar.commit,
  deployedLedger: stellar.deployedAt.ledger,
} as const;
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

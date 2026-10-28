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
} as const;
export const DESTINATIONS = [
  {
    key: "sepolia",
    name: "Ethereum Sepolia",
    axelarName: "ethereum-sepolia",
    decimals: 7,
    chainId: 11155111,
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    its: "0xB5FB4BE02232B1bBA4dC8f81dc24C26980dE9e3C",
  },
] as const;
export type DestinationKey = (typeof DESTINATIONS)[number]["key"];
export function destinationFor(key: string) {
  const destination = DESTINATIONS.find((chain) => chain.key === key);
  if (!destination) throw new Error("Choose a supported destination testnet.");
  return destination;
}

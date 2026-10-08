/**
 * EVM contract integration for HyperionRouter and adapters.
 *
 * Exposes typed contract ABIs and router deployments for connected EVM chains.
 */

import { hyperionRouterAbi } from "@hyperion/protocol/abi";

export { hyperionRouterAbi };

export const EVM_ROUTER_DEPLOYMENTS: Record<number, `0x${string}`> = {
  // Ethereum Sepolia
  11155111: "0x1234567890123456789012345678901234567890",
  // Base Sepolia
  84532: "0x2345678901234567890123456789012345678901",
  // Arbitrum Sepolia
  421614: "0x3456789012345678901234567890123456789012",
  // Optimism Sepolia
  11155420: "0x4567890123456789012345678901234567890123",
  // Arc Testnet
  5042: "0x5678901234567890123456789012345678901234",
};

export function getEvmRouterAddress(chainId: number): `0x${string}` | null {
  return EVM_ROUTER_DEPLOYMENTS[chainId] ?? null;
}

/**
 * Format and explorer deep link helpers for Hyperion.
 *
 * Resolves chain-specific block explorer deep links for transactions and accounts
 * across Stellar and supported EVM networks.
 */

export function shortenAddress(addr: string): string {
  if (!addr) return "";
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-6)}`;
}

export function shortenTxHash(hash: string): string {
  if (!hash) return "";
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 10)}...${hash.slice(-8)}`;
}

/**
 * Returns the block explorer deep link for a transaction hash or account address
 * given the specific network chain key.
 */
export function getExplorerUrl(chainKey: string, type: "tx" | "address", id: string): string {
  const cleanId = encodeURIComponent(id.trim());
  const normalizedKey = chainKey.trim().toLowerCase();

  switch (normalizedKey) {
    case "stellar-testnet": {
      if (type === "tx") {
        return `https://stellar.expert/explorer/testnet/tx/${cleanId}`;
      }
      const isContract = id.trim().startsWith("C");
      const pathSegment = isContract ? "contract" : "account";
      return `https://stellar.expert/explorer/testnet/${pathSegment}/${cleanId}`;
    }

    case "stellar":
    case "stellar-public": {
      if (type === "tx") {
        return `https://stellar.expert/explorer/public/tx/${cleanId}`;
      }
      const isContract = id.trim().startsWith("C");
      const pathSegment = isContract ? "contract" : "account";
      return `https://stellar.expert/explorer/public/${pathSegment}/${cleanId}`;
    }

    case "sepolia":
    case "ethereum-sepolia": {
      const segment = type === "tx" ? "tx" : "address";
      return `https://sepolia.etherscan.io/${segment}/${cleanId}`;
    }

    case "base-sepolia": {
      const segment = type === "tx" ? "tx" : "address";
      return `https://sepolia.basescan.org/${segment}/${cleanId}`;
    }

    case "arbitrum-sepolia": {
      const segment = type === "tx" ? "tx" : "address";
      return `https://sepolia.arbiscan.io/${segment}/${cleanId}`;
    }

    case "arc-testnet": {
      const segment = type === "tx" ? "tx" : "address";
      return `https://explorer.testnet.arc.io/${segment}/${cleanId}`;
    }

    case "ethereum":
    case "mainnet": {
      const segment = type === "tx" ? "tx" : "address";
      return `https://etherscan.io/${segment}/${cleanId}`;
    }

    case "base": {
      const segment = type === "tx" ? "tx" : "address";
      return `https://basescan.org/${segment}/${cleanId}`;
    }

    case "arc": {
      const segment = type === "tx" ? "tx" : "address";
      return `https://explorer.arc.io/${segment}/${cleanId}`;
    }

    default: {
      const segment = type === "tx" ? "tx" : "address";
      return `https://sepolia.etherscan.io/${segment}/${cleanId}`;
    }
  }
}

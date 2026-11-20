import { isWalletId } from "./sdk";

const WALLET_KEY = "hyperion.stellar.walletId";

export function readWalletPreference(): { id: string | null; error: string | null } {
  try {
    return { id: localStorage.getItem(WALLET_KEY), error: null };
  } catch {
    return {
      id: null,
      error: "Could not read the saved wallet preference. You can still connect a wallet.",
    };
  }
}

export function saveWalletPreference(id: string | null): string | null {
  try {
    if (id) localStorage.setItem(WALLET_KEY, id);
    else localStorage.removeItem(WALLET_KEY);
    return null;
  } catch {
    return "Could not update the saved wallet preference. Wallet access remains available.";
  }
}

export function isRecognizedWalletPreference(id: string | null) {
  return id === null || isWalletId(id);
}

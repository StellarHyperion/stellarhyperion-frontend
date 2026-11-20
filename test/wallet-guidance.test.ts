import { describe, expect, it } from "vitest";
import { walletErrorGuidance } from "../src/wallets/stellar/sdk";

describe("safe actionable connection guidance", () => {
  it.each([
    ["User denied requestAccess", "access_denied", false],
    [{ message: "User rejected connection" }, "access_denied", false],
    ["Install and open Freighter before connecting.", "extension_unavailable", true],
    ["Extension context invalidated.", "extension_unavailable", true],
    ["The wallet popup was blocked", "popup_blocked", false],
    ["Wallet does not support this network", "network_mismatch", false],
    ["Wallet did not respond in time", "connection_timeout", false],
  ])("maps %j to a focused recovery category", (message, category, install) => {
    const error = typeof message === "string" ? new Error(message) : message;
    expect(walletErrorGuidance(error)).toMatchObject({ category, install });
    expect(walletErrorGuidance(error).action.length).toBeGreaterThan(20);
  });
  it("never discloses arbitrary adapter details in user guidance", () => {
    const secret = "private-adapter-credential";
    const guidance = walletErrorGuidance(new Error(secret + " denied access " + "x".repeat(10000)));
    expect(JSON.stringify(guidance)).not.toContain(secret);
    expect(guidance.category).toBe("access_denied");
  });
});

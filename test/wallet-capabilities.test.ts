import { afterEach, describe, expect, it, vi } from "vitest";
import { walletAvailability, walletCapabilities } from "../src/wallets/stellar/capabilities";
const detect = vi.hoisted(() => vi.fn());
const request = vi.hoisted(() => vi.fn());
const sign = vi.hoisted(() => vi.fn());
vi.mock("@stellar/freighter-api", () => ({
  isConnected: detect,
  requestAccess: request,
  signTransaction: sign,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe("non-invasive wallet diagnostics", () => {
  it("distinguishes absent extensions from popup wallets without requesting a signature", async () => {
    vi.stubGlobal("window", {});
    detect.mockResolvedValue({ isConnected: false });
    expect(await walletAvailability("freighter")).toBe("missing_extension");
    expect(await walletAvailability("albedo")).toBe("popup_required");
    expect(await walletAvailability("xbull")).toBe("popup_required");
    detect.mockResolvedValue({ isConnected: true });
    expect(await walletAvailability("freighter")).toBe("installed");
    expect(request).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });
  it("keeps detector failures unknown and reports unsupported methods explicitly", async () => {
    vi.stubGlobal("window", {});
    detect.mockRejectedValue(new Error("disconnected"));
    expect(await walletAvailability("freighter")).toBe("unknown");
    expect(walletCapabilities("albedo").signingLimitations.canSignAuthEntry).toBe(false);
    expect(walletCapabilities("freighter").supportedAccountQueries.canListenAccountChange).toBe(
      false,
    );
  });
});

import { describe, expect, it, vi } from "vitest";
import { message } from "../src/lib/messages";
import { detectRuntimeCapabilities } from "../src/lib/runtime-capabilities";

describe("runtime capability messages", () => {
  it("has explicit fallback copy for user-facing capability states", () => {
    expect(message("staticFeeUnavailable")).toMatch(/Next\.js server/);
    expect(message("routeLoading")).toMatch(/bridge fees/);
  });

  it("keeps read-only history available when fee routes are missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(detectRuntimeCapabilities()).resolves.toEqual({
      feeRoutes: false,
      readOnlyHistory: true,
    });
    vi.unstubAllGlobals();
  });
});

import { describe, expect, it } from "vitest";
import { assertPublicConfiguration, publicEndpoint } from "../src/config/public-boundary";

describe("public configuration boundary", () => {
  it("rejects credentials at the public boundary", () => {
    expect(() => {
      assertPublicConfiguration({ NEXT_PUBLIC_API_TOKEN: "hidden" });
    }).toThrow();
    expect(() => {
      assertPublicConfiguration({ NEXT_PUBLIC_RPC_URL: "ghp_not-a-token" });
    }).toThrow();
    expect(publicEndpoint("NEXT_PUBLIC_RPC_URL", "https://rpc.example")).toBe(
      "https://rpc.example",
    );
  });
});

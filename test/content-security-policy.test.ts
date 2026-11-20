import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "../src/config/content-security-policy";
import {
  BROWSER_RESOURCE_ORIGINS,
  stellarTransactionReadUrls,
} from "../src/config/testnet";

describe("browser resource policy", () => {
  it("allows only configured public provider origins for browser connections", () => {
    const policy = contentSecurityPolicy("0123456789abcdef0123456789abcdef");
    const directive = policy.split("; ").find((value) => value.startsWith("connect-src "));
    expect(directive).toBe(`connect-src 'self' ${BROWSER_RESOURCE_ORIGINS.connect.join(" ")}`);
    expect(BROWSER_RESOURCE_ORIGINS.connect).toEqual(
      expect.arrayContaining([
        "https://soroban-testnet.stellar.org",
        "https://horizon-testnet.stellar.org",
        "https://ethereum-sepolia-rpc.publicnode.com",
        "https://sepolia.base.org",
        "https://rpc.testnet.arc.io",
      ]),
    );
    expect(directive).not.toContain("*");
  });

  it("uses a nonce for inline scripts and permits only configured wallet frames", () => {
    const nonce = "0123456789abcdef0123456789abcdef";
    const policy = contentSecurityPolicy(nonce);
    expect(policy).toContain(`script-src 'self' 'nonce-${nonce}'`);
    expect(policy).toContain(`frame-src 'self' ${BROWSER_RESOURCE_ORIGINS.wallet.join(" ")}`);
    const scripts = policy.split("; ").find((value) => value.startsWith("script-src "));
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(() => contentSecurityPolicy("bad nonce")).toThrow("nonce is invalid");
  });

  it("caps configured Stellar read endpoints and rejects wildcard origins", () => {
    const sources = stellarTransactionReadUrls(
      "https://first.example/rpc,https://first.example/other,https://second.example,https://third.example",
    );
    expect(sources).toHaveLength(3);
    expect(sources.map((source) => new URL(source).origin)).toEqual([
      "https://soroban-testnet.stellar.org",
      "https://first.example",
      "https://second.example",
    ]);
    expect(() => stellarTransactionReadUrls("https://*.example/rpc")).toThrow(
      "unauthenticated HTTP(S) URLs",
    );
  });
});

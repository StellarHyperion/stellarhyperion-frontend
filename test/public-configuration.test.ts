import { describe, expect, it } from "vitest";
import {
  TESTNET,
  publicConfigurationAdmission,
  validatePublicConfiguration,
} from "../src/config/testnet";

describe("Coherent public testnet configuration", () => {
  it("admits the published testnet without requiring a history server", () => {
    expect(publicConfigurationAdmission()).toEqual({ available: true, reasons: [] });
    expect(validatePublicConfiguration({ ...TESTNET, apiUrl: "" }).available).toBe(true);
  });
  it.each([
    { networkPassphrase: "Public Global Stellar Network ; September 2015" },
    { router: TESTNET.token },
    { token: TESTNET.router },
    { rpcUrl: "http://rpc.example" },
    { rpcUrl: "https://secret-user:secret-pass@rpc.example" },
    { rpcUrl: "https://rpc.example?credential=secret" },
    { horizonUrl: "javascript:alert(1)" },
    { horizonUrl: "https://history.example/#secret" },
    { apiUrl: "http://remote-api.example" },
    { apiUrl: "https://user:secret@api.example" },
    { indexerUrl: "https://api.example?key=secret" },
    { indexerUrl: "not a URL" },
  ])("blocks mixed identity or invalid public endpoints %j", (change) => {
    const admission = validatePublicConfiguration({ ...TESTNET, ...change });
    expect(admission.available).toBe(false);
    expect(admission.reasons.length).toBeGreaterThan(0);
    expect(admission.reasons.join(" ")).not.toMatch(
      /secret-pass|secret-user|credential=|key=|user:secret/,
    );
  });
  it.each([
    "https://api.example",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    "http://[::1]:3001",
  ])("admits explicit public or local development activity origins %s", (apiUrl) => {
    expect(validatePublicConfiguration({ ...TESTNET, apiUrl }).available).toBe(true);
  });
});

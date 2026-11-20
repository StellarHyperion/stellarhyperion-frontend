import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTransferProof, PROOF_CHECKS } from "../src/lib/transfer-proof";
import { fetchTransferEvidence, type FormattedTransfer } from "../src/api/backend";
import { publicReference } from "../src/lib/evidence";
const hash = `0x${"11".repeat(32)}`;
const blockHash = `0x${"22".repeat(32)}`;
const token = `0x${"33".repeat(20)}`;
const recipient = `0x${"44".repeat(20)}`;
const transfer: FormattedTransfer = {
  id: "7",
  stage: "delivered",
  route: 1,
  origin: {
    chain: "stellar-testnet",
    nonce: "1",
    sender: "GABC",
    token: "CUSDC",
    grossAmount: "100",
    fee: "1",
    netAmount: "99",
    block: "40",
    txHash: "aa".repeat(32),
    observedAt: "2026-11-20T12:00:00.000Z",
  },
  destination: {
    chain: "ethereum-sepolia",
    token,
    recipient,
    amount: "99",
    delivered: true,
    block: "50",
    txHash: hash,
    deliveredAt: "2026-11-20T12:00:01.000Z",
  },
  rail: null,
  claim: null,
};
const evidence = () => ({
  transferId: "7",
  evidenceStatus: "canonical",
  providerExecutionSufficient: false,
  verificationChecklist: Object.fromEntries(
    Object.keys(PROOF_CHECKS).map((key) => [key, { passed: true }]),
  ),
  command: { id: `0x${"55".repeat(32)}`, executionTransaction: hash },
  destinationReceipt: {
    transactionHash: hash,
    status: "success",
    blockNumber: "50",
    blockHash,
    canonical: true,
    lastRevalidatedAt: "2026-11-20T12:00:02.000Z",
  },
  tokenManagerMapping: {
    destinationChain: "ethereum-sepolia",
    proofBlockNumber: "50",
    proofBlockHash: blockHash,
    verified: true,
  },
  tokenPayment: { token, recipient, amount: "99", transactionHash: hash, exactMatch: true },
  quarantined: [
    {
      payload: {
        api_key: "private-provider-secret",
        url: "https://endpoint.example/api/private-provider-secret",
      },
    },
  ],
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("public projection of implemented backend proof contracts", () => {
  it("exposes actual message, receipt and canonical block references without provider payloads", () => {
    const proof = parseTransferProof(evidence(), transfer);
    expect(proof.status).toBe("verified");
    expect(proof.receiptBlockHash).toBe(blockHash);
    expect(proof.commandId).toBe(`0x${"55".repeat(32)}`);
    expect(JSON.stringify(proof)).not.toContain("private-provider-secret");
    expect(proof).not.toHaveProperty("quarantined");
  });
  it.each(Object.keys(PROOF_CHECKS))(
    "requires the independent %s check before labeling payment verified",
    (key) => {
      const value = evidence();
      const check = value.verificationChecklist[key];
      if (!check) throw new Error("Missing check.");
      check.passed = false;
      expect(parseTransferProof(value, transfer).status).toBe("candidate");
    },
  );
  it.each([
    "receipt hash",
    "failed receipt",
    "canonical block",
    "amount",
    "recipient",
    "token",
    "provider status",
    "source only",
  ])("keeps altered %s evidence unverified", (field) => {
    const value = evidence();
    let record = transfer;
    if (field === "receipt hash") value.destinationReceipt.transactionHash = `0x${"66".repeat(32)}`;
    if (field === "failed receipt") value.destinationReceipt.status = "reverted";
    if (field === "canonical block") value.destinationReceipt.canonical = false;
    if (field === "amount") value.tokenPayment.amount = "100";
    if (field === "recipient") value.tokenPayment.recipient = `0x${"66".repeat(20)}`;
    if (field === "token") value.tokenPayment.token = `0x${"66".repeat(20)}`;
    if (field === "provider status") value.evidenceStatus = "executed";
    if (field === "source only")
      record = { ...transfer, destination: { ...transfer.destination, delivered: false } };
    expect(parseTransferProof(value, record).status).toBe("candidate");
  });
  it("refuses mismatched transfer identities and sanitizes invalid public identifiers", () => {
    expect(() => parseTransferProof({ ...evidence(), transferId: "8" }, transfer)).toThrow("match");
    const value = evidence();
    value.command.id = "https://provider.example?api_key=private";
    value.destinationReceipt.blockHash = "private-provider-secret";
    const proof = parseTransferProof(value, transfer);
    expect(proof.commandId).toBeNull();
    expect(proof.receiptBlockHash).toBeNull();
    expect(proof.status).toBe("candidate");
  });
  it.each([
    `https://user:secret@testnet.axelarscan.io/gmp/${hash}`,
    `https://testnet.axelarscan.io/gmp/${hash}?token=secret`,
    `https://testnet.axelarscan.io/gmp/${hash}#secret`,
    `https://testnet.axelarscan.io/api/secret/${hash}`,
    `https://private.example/gmp/${hash}`,
    `http://testnet.axelarscan.io/gmp/${hash}`,
    `https://testnet.axelarscan.io:8443/gmp/${hash}`,
  ])("does not expose credential-bearing or unrecognized provider reference %s", (value) => {
    expect(publicReference(value)).toBeUndefined();
  });
  it("accepts a public explorer command reference without endpoint parameters", () => {
    expect(publicReference(`https://testnet.axelarscan.io/gmp/${hash}`)).toBe(
      `https://testnet.axelarscan.io/gmp/${hash}`,
    );
  });
  it("uses the real numeric-id proof endpoint and makes no request for invalid identifiers", async () => {
    vi.stubEnv("NEXT_PUBLIC_HYPERION_API_URL", "https://indexer.example");
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(evidence())));
    vi.stubGlobal("fetch", fetcher);
    expect((await fetchTransferEvidence(transfer)).status).toBe("verified");
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://indexer.example/v1/transfers/7/evidence");
    await expect(fetchTransferEvidence({ ...transfer, id: "../secret" })).rejects.toThrow(
      "identifier",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

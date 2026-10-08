import { describe, expect, it } from "vitest";
import { getExplorerUrl, shortenAddress, shortenTxHash } from "../src/lib/format";

describe("Block Explorer Deep Links & Address Formatting", () => {
  it("resolves Stellar testnet transaction and account deep links", () => {
    const txHash = "e2c3b4a5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef12";
    const accountId = "GCHPVETUL5E4YKDLMRIBFUGFK4PMYOVKPFALVSYMP2QDYAVBA3ITQDAI";
    const contractId = "CDMOLDF4SJDEDRWTDF7XAYMSRE6L3YEHHIRF57CFWNQYNC6ZOZ5LWCWF";

    expect(getExplorerUrl("stellar-testnet", "tx", txHash)).toBe(
      `https://stellar.expert/explorer/testnet/tx/${txHash}`,
    );
    expect(getExplorerUrl("stellar-testnet", "address", accountId)).toBe(
      `https://stellar.expert/explorer/testnet/account/${accountId}`,
    );
    expect(getExplorerUrl("stellar-testnet", "address", contractId)).toBe(
      `https://stellar.expert/explorer/testnet/contract/${contractId}`,
    );
  });

  it("resolves Sepolia transaction and address deep links", () => {
    const txHash = "0x4a8f9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90";
    const address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

    expect(getExplorerUrl("sepolia", "tx", txHash)).toBe(
      `https://sepolia.etherscan.io/tx/${txHash}`,
    );
    expect(getExplorerUrl("sepolia", "address", address)).toBe(
      `https://sepolia.etherscan.io/address/${address}`,
    );
    expect(getExplorerUrl("ethereum-sepolia", "tx", txHash)).toBe(
      `https://sepolia.etherscan.io/tx/${txHash}`,
    );
  });

  it("resolves Base Sepolia transaction and address deep links", () => {
    const txHash = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    const address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

    expect(getExplorerUrl("base-sepolia", "tx", txHash)).toBe(
      `https://sepolia.basescan.org/tx/${txHash}`,
    );
    expect(getExplorerUrl("base-sepolia", "address", address)).toBe(
      `https://sepolia.basescan.org/address/${address}`,
    );
  });

  it("resolves Arbitrum Sepolia transaction and address deep links", () => {
    const txHash = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

    expect(getExplorerUrl("arbitrum-sepolia", "tx", txHash)).toBe(
      `https://sepolia.arbiscan.io/tx/${txHash}`,
    );
    expect(getExplorerUrl("arbitrum-sepolia", "address", address)).toBe(
      `https://sepolia.arbiscan.io/address/${address}`,
    );
  });

  it("resolves Arc testnet transaction and address deep links", () => {
    const txHash = "0xdeadbeef1234567890abcdef";
    const address = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";

    expect(getExplorerUrl("arc-testnet", "tx", txHash)).toBe(
      `https://explorer.testnet.arc.io/tx/${txHash}`,
    );
    expect(getExplorerUrl("arc-testnet", "address", address)).toBe(
      `https://explorer.testnet.arc.io/address/${address}`,
    );
  });

  it("formats and shortens addresses and transaction hashes cleanly", () => {
    expect(shortenAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")).toBe("0x7099...dc79C8");
    expect(shortenAddress("GCHPVETUL5E4YKDLMRIBFUGFK4PMYOVKPFALVSYMP2QDYAVBA3ITQDAI")).toBe(
      "GCHPVE...ITQDAI",
    );
    expect(shortenAddress("short")).toBe("short");
    expect(shortenAddress("")).toBe("");

    expect(
      shortenTxHash("0x4a8f9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90"),
    ).toBe("0x4a8f9b1c...6d7e8f90");
    expect(shortenTxHash("short-hash")).toBe("short-hash");
  });
});

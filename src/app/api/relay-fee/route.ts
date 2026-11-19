import { NextResponse } from "next/server";
import { relayBudget } from "../../../lib/relay-budget";
import { fetchWithDeadline } from "../../../lib/provider-request";
import { validateProviderFee } from "../../../lib/fee-schema";
// The fee API expects a method in the JSON body. Its /gmp/estimateITSFee path returns help text.
export async function GET() {
  try {
    const response = await fetchWithDeadline("https://testnet.api.gmp.axelarscan.io", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "estimateITSFee",
        sourceChain: "stellar-2026-q1-2",
        destinationChain: "ethereum-sepolia",
        event: "InterchainTransfer",
      }),
      cache: "no-store",
    });
    const value = (await response.text()).trim().replace(/^"(\d+)"$/, "$1");
    if (!response.ok || value.length > 39 || !/^\d+$/.test(value) || BigInt(value) <= 0n)
      throw new Error("Invalid gas estimate");
    const quote = validateProviderFee(
      {
        amount: String(relayBudget(BigInt(value))),
        estimatedAmount: value,
        token: "XLM",
        decimals: 7,
        destination: "ethereum-sepolia",
      },
      { token: "XLM", destination: "ethereum-sepolia" },
    );
    return NextResponse.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { error: "Relay gas pricing is unavailable. No transfer can be prepared." },
      { status: 503 },
    );
  }
}

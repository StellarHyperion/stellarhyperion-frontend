import { NextResponse } from "next/server";
import { boundedRetryAfter, relayBudget } from "../../../lib/relay-budget";
// The fee API expects a method in the JSON body. Its /gmp/estimateITSFee path returns help text.
export async function GET() {
  try {
    const response = await fetch("https://testnet.api.gmp.axelarscan.io", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "estimateITSFee",
        sourceChain: "stellar-2026-q1-2",
        destinationChain: "ethereum-sepolia",
        event: "InterchainTransfer",
      }),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (response.status === 429 || response.status === 503) {
      const retryAfter = boundedRetryAfter(response.headers.get("retry-after"));
      return NextResponse.json(
        { error: "Axelar relay gas pricing is rate-limited. No transfer can be prepared." },
        {
          status: 429,
          headers: {
            "Cache-Control": "no-store",
            ...(retryAfter === null ? {} : { "Retry-After": String(retryAfter) }),
          },
        },
      );
    }
    const value = (await response.text()).trim().replace(/^"(\d+)"$/, "$1");
    if (!response.ok || !/^\d+$/.test(value) || BigInt(value) <= 0n)
      throw new Error("Invalid gas estimate");
    return NextResponse.json(
      {
        amount: String(relayBudget(BigInt(value))),
        estimatedAmount: value,
        token: "XLM",
        decimals: 7,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Relay gas pricing is unavailable. No transfer can be prepared." },
      { status: 503 },
    );
  }
}

import { NextResponse } from "next/server";
import { destinationFor } from "../../../config/testnet";
import { relayBudget } from "../../../lib/relay-budget";
import { selectFinalizedCctpFee } from "../../../lib/cctp-fee";

export async function GET(request: Request) {
  let domain: number;
  try {
    domain = destinationFor(new URL(request.url).searchParams.get("destination") ?? "").cctpDomain;
  } catch {
    return NextResponse.json({ error: "Choose a supported destination testnet." }, { status: 400 });
  }
  try {
    const response = await fetch(
      `https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/27/${domain}?forward=true`,
      {
        signal: AbortSignal.timeout(15000),
        cache: "no-store",
      },
    );
    const fee = selectFinalizedCctpFee(await response.json());
    if (!response.ok || fee === null)
      throw new Error("No unambiguous finalized forwarding estimate.");
    return NextResponse.json(
      {
        amount: String(relayBudget(fee.amount) * 10n),
        estimatedAmount: String(fee.amount * 10n),
        token: "USDC",
        decimals: 7,
        finality: 2000,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Circle forwarding pricing is unavailable. Try again later." },
      { status: 503 },
    );
  }
}

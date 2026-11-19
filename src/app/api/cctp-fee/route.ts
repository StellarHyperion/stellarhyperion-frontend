import { NextResponse } from "next/server";
import { destinationFor } from "../../../config/testnet";
import { relayBudget } from "../../../lib/relay-budget";
import { selectFinalizedCctpFee } from "../../../lib/cctp-fee";
import { validateProviderFee } from "../../../lib/fee-schema";

export async function GET(request: Request) {
  let destination: ReturnType<typeof destinationFor>;
  try {
    destination = destinationFor(new URL(request.url).searchParams.get("destination") ?? "");
  } catch {
    return NextResponse.json({ error: "Choose a supported destination testnet." }, { status: 400 });
  }
  try {
    const response = await fetch(
      `https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/27/${destination.cctpDomain}?forward=true`,
      {
        signal: AbortSignal.timeout(15000),
        cache: "no-store",
      },
    );
    const body: unknown = await response.json();
    if (!response.ok || !Array.isArray(body) || body.length > 32)
      throw new Error("Invalid Circle fee response.");
    const fee = selectFinalizedCctpFee(body);
    if (fee === null)
      throw new Error("No unambiguous finalized forwarding estimate.");
    const quote = validateProviderFee(
      {
        amount: String(relayBudget(fee.amount) * 10n),
        estimatedAmount: String(fee.amount * 10n),
        token: "USDC",
        decimals: 7,
        destination: destination.key,
        finality: 2000,
      },
      {
        token: "USDC",
        destination: destination.key,
      },
    );
    return NextResponse.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { error: "Circle forwarding pricing is unavailable. Try again later." },
      { status: 503 },
    );
  }
}

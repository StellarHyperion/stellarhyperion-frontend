import { NextResponse } from "next/server";
import { destinationFor } from "../../../config/testnet";
import { relayBudget } from "../../../lib/relay-budget";
import {
  feeRequestGuard,
  readFeeResponse,
  validateFeeRequest,
} from "../../../lib/fee-request-guard";
import { validateProviderFee } from "../../../lib/fee-schema";

export async function GET(request: Request) {
  let url: URL;
  try {
    url = validateFeeRequest(request, ["destination"]);
  } catch {
    return NextResponse.json(
      { error: "Choose a supported fee request.", code: "BAD_REQUEST" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const admission = feeRequestGuard.acquire();
  if ("retryAfter" in admission)
    return NextResponse.json(
      {
        error: "Fee estimates are busy. Retry after the indicated delay.",
        code: "RATE_LIMITED",
        retryAfter: admission.retryAfter,
      },
      {
        status: 429,
        headers: { "Retry-After": String(admission.retryAfter), "Cache-Control": "no-store" },
      },
    );
  let destination: ReturnType<typeof destinationFor>;
  try {
    destination = destinationFor(url.searchParams.get("destination") ?? "");
  } catch {
    admission.release();
    return NextResponse.json(
      { error: "Choose a supported destination testnet.", code: "BAD_REQUEST" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const response = await fetch(
      `https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/27/${destination.cctpDomain}?forward=true`,
      {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
        cache: "no-store",
      },
    );
    const body: unknown = JSON.parse(await readFeeResponse(response));
    if (!response.ok || !Array.isArray(body) || body.length > 32)
      throw new Error("Invalid Circle fee response.");
    const fee = body.find(
      (
        item: unknown,
      ): item is { finalityThreshold: number; minimumFee: number; forwardFee: { med: number } } => {
        if (!item || typeof item !== "object") return false;
        const entry = item as Record<string, unknown>;
        return (
          entry.finalityThreshold === 2000 &&
          entry.minimumFee === 0 &&
          entry.forwardFee !== null &&
          typeof entry.forwardFee === "object" &&
          !Array.isArray(entry.forwardFee)
        );
      },
    );
    if (!fee || !Number.isSafeInteger(fee.forwardFee.med) || fee.forwardFee.med <= 0)
      throw new Error("No finalized forwarding estimate.");
    const quote = validateProviderFee(
      {
        amount: String(relayBudget(BigInt(fee.forwardFee.med)) * 10n),
        estimatedAmount: String(BigInt(fee.forwardFee.med) * 10n),
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
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    admission.release();
  }
}

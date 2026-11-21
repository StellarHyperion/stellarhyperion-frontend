import { fetchWithDeadline } from "../../../lib/provider-request";
import { NextResponse } from "next/server";
import { feeRouteCapabilityResponse } from "../../../lib/runtime-capabilities";
import { destinationFor } from "../../../config/testnet";
import { feeObservation, relayBudget } from "../../../lib/relay-budget";
import {
  feeRequestGuard,
  readFeeResponse,
  validateFeeRequest,
  providerFeeCooldown,
} from "../../../lib/fee-request-guard";
import { createSingleFlightCache } from "../../../lib/single-flight";
import type { ProviderFeeQuote } from "../../../lib/fee-schema";
import { selectFinalizedCctpFee } from "../../../lib/cctp-fee";
import { validateProviderFee } from "../../../lib/fee-schema";

const loadCircleFee = createSingleFlightCache<ProviderFeeQuote>(2_000);

export function HEAD(): Response {
  return feeRouteCapabilityResponse("cctp");
}

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
  const cooldown = providerFeeCooldown.remaining("cctp");
  if (cooldown > 0) {
    admission.release();
    return NextResponse.json(
      {
        error: "Live provider pricing is cooling down. No transfer can be prepared.",
        code: "RATE_LIMITED",
        retryAfter: cooldown,
      },
      { status: 429, headers: { "Retry-After": String(cooldown), "Cache-Control": "no-store" } },
    );
  }
  if (!destination.routes.includes(0)) {
    admission.release();
    return NextResponse.json(
      { error: "The CCTP lane is not active for this destination." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const quote = await loadCircleFee(
      `circle:USDC:${destination.key}:${destination.cctpDomain}`,
      async () => {
        const response = await fetchWithDeadline(
          `https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/27/${destination.cctpDomain}?forward=true`,
          {
            signal: AbortSignal.timeout(15_000),
            cache: "no-store",
          },
        );
        if (response.status === 429 || response.status === 503) {
          const retryAfter = providerFeeCooldown.block("cctp", response.headers.get("retry-after"));
          await response.body?.cancel();
          throw new Error(`Provider fee cooldown: ${retryAfter}`);
        }
        const body: unknown = JSON.parse(await readFeeResponse(response));
        if (!response.ok || !Array.isArray(body) || body.length > 32)
          throw new Error("Invalid Circle fee response.");
        const fee = selectFinalizedCctpFee(body);
        if (fee === null) throw new Error("No unambiguous finalized forwarding estimate.");
        return validateProviderFee(
          {
            amount: String(relayBudget(fee.amount) * 10n),
            estimatedAmount: String(fee.amount * 10n),
            token: "USDC",
            decimals: 7,
            destination: destination.key,
            finality: 2000,
            provider: "Circle CCTP",
            ...feeObservation(),
            lane: { source: "stellar-testnet", destination: destination.key, route: 0 },
          },
          {
            token: "USDC",
            destination: destination.key,
          },
        );
      },
    );
    return NextResponse.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch {
    const retryAfter = providerFeeCooldown.remaining("cctp");
    if (retryAfter > 0)
      return NextResponse.json(
        {
          error: "Live provider pricing is cooling down. No transfer can be prepared.",
          code: "RATE_LIMITED",
          retryAfter,
        },
        {
          status: 429,
          headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" },
        },
      );
    return NextResponse.json(
      { error: "Circle forwarding pricing is unavailable. Try again later." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    admission.release();
  }
}

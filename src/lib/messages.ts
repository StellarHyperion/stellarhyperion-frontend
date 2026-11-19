export type MessageKey = "routeLoading" | "staticFeeUnavailable" | "transactionSubmitted";

const messages: Record<MessageKey, string> = {
  routeLoading: "Checking liquidity, bridge fees and the receive amount",
  staticFeeUnavailable:
    "This deployment cannot provide live fee routes. Use the supported Next.js server deployment.",
  transactionSubmitted:
    "The transaction was submitted. Source confirmation and destination delivery are tracked separately.",
};

export function message(key: MessageKey): string {
  return messages[key];
}

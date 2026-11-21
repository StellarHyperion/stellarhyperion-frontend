import { BROWSER_RESOURCE_ORIGINS } from "./testnet";

export function contentSecurityPolicy(nonce?: string, requestOrigin?: string): string {
  if (nonce !== undefined && !/^[A-Za-z0-9_-]{16,128}$/.test(nonce))
    throw new Error("The content security policy nonce is invalid.");

  const scripts = ["'self'", ...(nonce ? [`'nonce-${nonce}'`] : [])];
  if (process.env.NODE_ENV === "development") scripts.push("'unsafe-eval'");

  const developmentSocket: string[] = [];
  if (process.env.NODE_ENV === "development" && requestOrigin) {
    const url = new URL(requestOrigin);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("The development origin must use HTTP(S).");
    developmentSocket.push(`${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`);
  }

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src ${scripts.join(" ")}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${BROWSER_RESOURCE_ORIGINS.connect.join(" ")} ${developmentSocket.join(" ")}`.trim(),
    `frame-src 'self' ${BROWSER_RESOURCE_ORIGINS.wallet.join(" ")}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    ...(process.env.NODE_ENV === "production" ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

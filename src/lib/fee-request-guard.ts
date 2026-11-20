import { createFeeCooldown } from "./relay-budget";

export const FEE_WINDOW_MS = 60_000;
export const FEE_MAX_REQUESTS = 120;
export const FEE_MAX_IN_FLIGHT = 4;
export const FEE_MAX_RESPONSE_BYTES = 8192;

type FeeAdmission = { release: () => void } | { retryAfter: number };

/** A bounded process budget shared by both providers; forwarding headers cannot reset it. */
export function createFeeRequestGuard(now = Date.now) {
  let startedAt = now();
  let count = 0;
  let inFlight = 0;
  return {
    acquire(): FeeAdmission {
      const current = now();
      if (current - startedAt >= FEE_WINDOW_MS) {
        startedAt = current;
        count = 0;
      }
      if (count >= FEE_MAX_REQUESTS)
        return {
          retryAfter: Math.max(1, Math.ceil((FEE_WINDOW_MS - (current - startedAt)) / 1000)),
        };
      if (inFlight >= FEE_MAX_IN_FLIGHT) return { retryAfter: 1 };
      count++;
      inFlight++;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          inFlight--;
        },
      };
    },
  };
}

// Next may load routes through separate bundles. Keep one budget for this server process.
const runtime = globalThis as typeof globalThis & {
  __hyperionProviderFeeCooldown?: ReturnType<typeof createFeeCooldown>;
  __hyperionFeeRequestGuard?: ReturnType<typeof createFeeRequestGuard>;
};
export const providerFeeCooldown = (runtime.__hyperionProviderFeeCooldown ??= createFeeCooldown());
export const feeRequestGuard = (runtime.__hyperionFeeRequestGuard ??= createFeeRequestGuard());

export function validateFeeRequest(request: Request, allowed: readonly string[]): URL {
  if (request.url.length > 2048) throw new Error("Fee request is too long.");
  const url = new URL(request.url);
  for (const key of url.searchParams.keys())
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
      throw new Error("Unsupported fee request parameter.");
  return url;
}

/** Read provider text only after enforcing its byte budget. */
export async function readFeeResponse(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > FEE_MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new Error("Provider fee response exceeds its budget.");
  }
  if (!response.body) throw new Error("Missing provider fee response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes: unknown = chunk.value;
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > FEE_MAX_RESPONSE_BYTES - length)
        throw new Error("Provider fee response exceeds its budget.");
      chunks.push(bytes);
      length += bytes.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

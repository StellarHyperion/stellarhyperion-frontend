/** Ten percent headroom, rounded up in the rail's representable fee units. */
export function relayBudget(estimate: bigint, quantum = 1n): bigint {
  if (estimate <= 0n || quantum <= 0n) throw new Error("A positive live fee estimate is required.");
  return ((estimate * 110n + 100n * quantum - 1n) / (100n * quantum)) * quantum;
}

/** Explicit five-second cache lifetime matching one Stellar ledger window. */
export const FEE_QUOTE_TTL_MS = 5_000;

/** Explicit fifteen-second upstream lifetime for live provider fee reads. */
export const FEE_QUOTE_TIMEOUT_MS = 15_000;

export type FeeProvider = "axelar-its" | "circle-cctp";

export interface FeeQuoteKeyParts {
  provider: FeeProvider;
  source: string;
  destination: string;
  token: string;
  issuer: string | null;
  decimals: number;
}

export interface FeeQuotePayload {
  amount: string;
  estimatedAmount: string;
  token: string;
  issuer: string | null;
  decimals: number;
  finality?: number;
}

export interface SingleFlightConfig<T> {
  ttlMs?: number | undefined;
  timeoutMs?: number | undefined;
  now?: (() => number) | undefined;
  clone?: ((value: T) => T) | undefined;
  validate?: ((value: T) => T) | undefined;
}

export interface CoalesceCallOptions {
  signal?: AbortSignal | undefined;
  bypassCache?: boolean | undefined;
}

export interface SingleFlightCoalescer<T> {
  coalesce: (
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    options?: CoalesceCallOptions,
  ) => Promise<T>;
  clear: () => void;
  size: () => { cached: number; inFlight: number };
}

interface CachedQuote<T> {
  value: T;
  expiresAt: number;
}

interface InFlightQuote<T> {
  subscribers: number;
  settled: boolean;
  abandoned: boolean;
  controller: AbortController;
  promise: Promise<T>;
}

export function feeQuoteKey(parts: FeeQuoteKeyParts): string {
  if (!parts.source.trim() || !parts.destination.trim() || !parts.token.trim()) {
    throw new Error("Fee quote key requires non-empty source, destination, and token.");
  }
  if (!Number.isSafeInteger(parts.decimals) || parts.decimals < 0) {
    throw new Error("Fee quote key requires a non-negative integer token precision.");
  }
  return [
    parts.provider,
    parts.source.trim(),
    parts.destination.trim(),
    parts.token.trim(),
    parts.issuer?.trim() ?? "native",
    String(parts.decimals),
  ].join("|");
}

export function validateFeeQuotePayload(quote: FeeQuotePayload): FeeQuotePayload {
  if (!/^\d+$/.test(quote.amount) || !/^\d+$/.test(quote.estimatedAmount)) {
    throw new Error("Fee quote amounts must be canonical positive integer strings.");
  }
  const amount = BigInt(quote.amount);
  const estimated = BigInt(quote.estimatedAmount);
  if (estimated <= 0n || amount < estimated) {
    throw new Error("Live fee quote must be positive and include non-negative budget headroom.");
  }
  if (!quote.token.trim() || !Number.isSafeInteger(quote.decimals) || quote.decimals <= 0) {
    throw new Error("Fee quote token metadata is invalid.");
  }
  if (quote.issuer !== null && !quote.issuer.trim()) {
    throw new Error("Issued fee quote token requires a non-empty issuer.");
  }
  return {
    amount: quote.amount,
    estimatedAmount: quote.estimatedAmount,
    token: quote.token,
    issuer: quote.issuer,
    decimals: quote.decimals,
    ...(quote.finality !== undefined ? { finality: quote.finality } : {}),
  };
}

export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const message =
    typeof reason === "string" && reason.length > 0
      ? reason
      : "The fee quote request was cancelled.";
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function createSingleFlightCoalescer<T>(
  config: SingleFlightConfig<T> = {},
): SingleFlightCoalescer<T> {
  const ttlMs = config.ttlMs ?? FEE_QUOTE_TTL_MS;
  const timeoutMs = config.timeoutMs ?? FEE_QUOTE_TIMEOUT_MS;
  const now = config.now ?? (() => Date.now());
  const clone = config.clone ?? ((value: T): T => structuredClone(value));
  const validate = config.validate ?? ((value: T): T => value);

  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error("Single-flight cache lifetime must be a non-negative finite duration.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Single-flight upstream timeout must be a positive finite duration.");
  }

  const cache = new Map<string, CachedQuote<T>>();
  const inFlight = new Map<string, InFlightQuote<T>>();

  const evictExpired = (timestamp: number) => {
    for (const [entryKey, entry] of cache) {
      if (entry.expiresAt <= timestamp) cache.delete(entryKey);
    }
  };

  const startFlight = (
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
  ): InFlightQuote<T> => {
    const controller = new AbortController();
    const upstreamSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    const flight: InFlightQuote<T> = {
      subscribers: 0,
      settled: false,
      abandoned: false,
      controller,
      promise: Promise.resolve(undefined as never),
    };
    flight.promise = (async () => {
      try {
        const raw = await load(upstreamSignal);
        const verified = validate(raw);
        if (!flight.abandoned && ttlMs > 0) {
          cache.set(key, {
            value: clone(verified),
            expiresAt: now() + ttlMs,
          });
        }
        return verified;
      } catch (error: unknown) {
        if (!flight.abandoned) {
          cache.delete(key);
        }
        throw error;
      } finally {
        flight.settled = true;
        if (inFlight.get(key) === flight) {
          inFlight.delete(key);
        }
      }
    })();
    inFlight.set(key, flight);
    return flight;
  };

  const coalesce = (
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    options: CoalesceCallOptions = {},
  ): Promise<T> => {
    const callerSignal = options.signal;
    if (callerSignal?.aborted) {
      return Promise.reject(abortReason(callerSignal));
    }

    const timestamp = now();
    evictExpired(timestamp);

    if (!options.bypassCache) {
      const cached = cache.get(key);
      if (cached && cached.expiresAt > timestamp) {
        return Promise.resolve(clone(cached.value));
      }
    }

    const flight = inFlight.get(key) ?? startFlight(key, load);
    flight.subscribers += 1;

    return new Promise<T>((resolve, reject) => {
      let detached = false;

      const onAbort = () => {
        if (detached || !callerSignal) return;
        detached = true;
        flight.subscribers -= 1;
        if (flight.subscribers <= 0 && !flight.settled) {
          flight.abandoned = true;
          if (inFlight.get(key) === flight) {
            inFlight.delete(key);
          }
          flight.controller.abort();
        }
        reject(abortReason(callerSignal));
      };

      if (callerSignal) {
        callerSignal.addEventListener("abort", onAbort, { once: true });
      }

      flight.promise.then(
        (value) => {
          if (callerSignal) {
            callerSignal.removeEventListener("abort", onAbort);
          }
          if (!detached) {
            detached = true;
            resolve(clone(value));
          }
        },
        (error: unknown) => {
          if (callerSignal) {
            callerSignal.removeEventListener("abort", onAbort);
          }
          if (!detached) {
            detached = true;
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      );
    });
  };

  return {
    coalesce,
    clear: () => {
      cache.clear();
      for (const flight of inFlight.values()) {
        flight.abandoned = true;
        flight.controller.abort();
      }
      inFlight.clear();
    },
    size: () => {
      evictExpired(now());
      return { cached: cache.size, inFlight: inFlight.size };
    },
  };
}

export const feeQuoteCoalescer = createSingleFlightCoalescer<FeeQuotePayload>({
  validate: validateFeeQuotePayload,
});

export function resetFeeQuoteCache(): void {
  feeQuoteCoalescer.clear();
}

/**
 * A browser wallet extension can simply never answer: the popup is blocked, the extension is
 * busy, or the user walks away from an approval prompt. Without a bound, that leaves a "connecting"
 * or "authorizing" control spinning forever. `withTimeout` races a promise against a timer and
 * rejects with `WalletTimeoutError` if the timer wins, so a stalled call always frees the caller's
 * loading state in bounded time.
 *
 * The underlying call itself cannot be cancelled: none of the wallet APIs this app talks to accept
 * an `AbortSignal`. So the original promise keeps running in the background after a timeout fires.
 * This function only ever lets the FIRST settlement (ours, or the real one) reach the caller - a
 * `then`/`catch` reaching the already-timed-out race is dropped, never resolving or rejecting
 * twice. That is what makes the timeout "cancellable": the timer itself is always cleared, and a
 * late, real adapter response can never retroactively resolve or reject a call the caller has
 * already moved on from.
 */
export class WalletTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletTimeoutError";
  }
}

/**
 * A wallet's signing prompt is the one request this app must never guess the outcome of: the
 * extension may have the user's approval sitting in a popup, or it may have already discarded the
 * request, and there is no way to tell from here. Timing out a signing call is therefore not a
 * failure like a stalled account lookup - it is deliberately UNCERTAIN, and callers must treat it
 * that way: never resubmit, never assume success, and never treat it the same as an explicit
 * rejection. This subtype lets a caller tell the two apart with `instanceof`.
 */
export class WalletSigningUncertainError extends WalletTimeoutError {
  constructor(message: string) {
    super(message);
    this.name = "WalletSigningUncertainError";
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  ErrorClass: new (message: string) => Error = WalletTimeoutError,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const reason: unknown = signal?.reason;
      reject(
        reason instanceof Error
          ? reason
          : new Error(typeof reason === "string" ? reason : "Wallet request cancelled."),
      );
    };
    const timer = setTimeout(() => {
      settled = true;
      cleanup();
      reject(new ErrorClass(message));
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

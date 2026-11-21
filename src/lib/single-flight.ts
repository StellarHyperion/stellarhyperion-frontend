interface Entry<T> {
  promise: Promise<T>;
  expiresAt: number;
}

export function createSingleFlightCache<T>(ttlMs: number) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)
    throw new Error("A positive single-flight lifetime is required.");

  const entries = new Map<string, Entry<T>>();

  return (key: string, load: () => Promise<T>): Promise<T> => {
    const now = Date.now();
    const existing = entries.get(key);
    if (existing && existing.expiresAt > now) return existing.promise;
    if (existing) entries.delete(key);

    const entry: Entry<T> = {
      promise: Promise.resolve().then(load),
      expiresAt: Number.POSITIVE_INFINITY,
    };
    entry.promise = entry.promise.then(
      (value) => {
        entry.expiresAt = Date.now() + ttlMs;
        return value;
      },
      (error: unknown) => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      },
    );
    entries.set(key, entry);
    return entry.promise;
  };
}

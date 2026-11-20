import { describe, expect, it } from "vitest";
import { CapabilityCache, type CapabilityCacheKey } from "../src/lib/capability-cache";

const key = (adapter: string): CapabilityCacheKey => ({
  network: "testnet",
  router: "router-a",
  adapter,
  resource: "methods",
});

describe("deployment-scoped capability cache", () => {
  it("deduplicates reads only within the exact lane and expires them", async () => {
    let now = 0;
    let reads = 0;
    const cache = new CapabilityCache(10, () => now);
    const read = () => Promise.resolve(++reads);
    await expect(cache.get(key("adapter-a"), read)).resolves.toBe(1);
    await expect(cache.get(key("adapter-a"), read)).resolves.toBe(1);
    await expect(cache.get(key("adapter-b"), read)).resolves.toBe(2);
    now = 11;
    await expect(cache.get(key("adapter-a"), read)).resolves.toBe(3);
  });

  it("evicts failed reads and supports explicit invalidation", async () => {
    let reads = 0;
    const cache = new CapabilityCache(100);
    await expect(
      cache.get(key("adapter-a"), () => {
        reads++;
        return Promise.reject(new Error("offline"));
      }),
    ).rejects.toThrow("offline");
    await expect(cache.get(key("adapter-a"), () => Promise.resolve(++reads))).resolves.toBe(2);
    cache.invalidate(key("adapter-a"));
    await expect(cache.get(key("adapter-a"), () => Promise.resolve(++reads))).resolves.toBe(3);
  });

  it("cannot let an expired failed request evict its newer healthy replacement", async () => {
    let now = 0;
    let rejectOld: ((error: Error) => void) | undefined;
    const cache = new CapabilityCache<number>(10, () => now);
    const old = cache.get(
      key("adapter-a"),
      () =>
        new Promise((_, reject) => {
          rejectOld = reject;
        }),
    );
    const failure = expect(old).rejects.toThrow("late failure");
    await Promise.resolve();
    now = 11;
    await expect(cache.get(key("adapter-a"), () => Promise.resolve(2))).resolves.toBe(2);
    if (!rejectOld) throw new Error("Expected the old pending read");
    rejectOld(new Error("late failure"));
    await failure;
    await expect(cache.get(key("adapter-a"), () => Promise.resolve(3))).resolves.toBe(2);
  });

  it("bounds retained discovery and distinguishes a deployment revision", async () => {
    const cache = new CapabilityCache<number>(100, () => 0, 2);
    let reads = 0;
    const read = () => Promise.resolve(++reads);
    await cache.get({ ...key("adapter-a"), revision: "one" }, read);
    await cache.get({ ...key("adapter-a"), revision: "two" }, read);
    await cache.get(key("adapter-b"), read);
    await expect(cache.get({ ...key("adapter-a"), revision: "one" }, read)).resolves.toBe(4);
    await expect(cache.get(key("adapter-b"), read)).resolves.toBe(3);
  });

  it("does not retain unknown discovery or synchronous failures", async () => {
    const cache = new CapabilityCache<number | null>(100);
    await expect(cache.get(key("adapter-a"), () => Promise.resolve(null))).resolves.toBe(null);
    await expect(cache.get(key("adapter-a"), () => Promise.resolve(1))).resolves.toBe(1);
    cache.invalidate();
    await expect(
      cache.get(key("adapter-a"), () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    await expect(cache.get(key("adapter-a"), () => Promise.resolve(2))).resolves.toBe(2);
  });
});

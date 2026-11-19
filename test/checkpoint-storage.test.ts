import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCheckpointStorage } from "../src/contracts/checkpoint";

afterEach(() => vi.unstubAllGlobals());

describe("checkpoint storage durability", () => {
  it("preflights writable storage before signing", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    expect(() => assertCheckpointStorage()).not.toThrow();
    expect(values.size).toBe(0);
  });
  it("fails closed when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    });
    expect(() => assertCheckpointStorage()).toThrow("storage is unavailable");
  });
});

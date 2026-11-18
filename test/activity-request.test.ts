import { describe, expect, it } from "vitest";
import { ActivityRequestGuard } from "../src/lib/activity-request";

describe("ActivityRequestGuard", () => {
  it("rejects a late response after switching accounts", () => {
    const guard = new ActivityRequestGuard();

    guard.setIdentity("GOLD-ACCOUNT");
    const oldRequest = guard.begin();
    guard.setIdentity("NEW-ACCOUNT");

    expect(guard.isCurrent(oldRequest)).toBe(false);
    expect(guard.isCurrent(guard.begin())).toBe(true);
  });

  it("rejects an earlier refresh for the same account", () => {
    const guard = new ActivityRequestGuard();

    guard.setIdentity("ACCOUNT");
    const firstRefresh = guard.begin();
    const latestRefresh = guard.begin();

    expect(guard.isCurrent(firstRefresh)).toBe(false);
    expect(guard.isCurrent(latestRefresh)).toBe(true);
  });
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, firefox } from "@playwright/test";

// Two real pages share storage to exercise recovery after one tab closes. This harness never
// connects a wallet or broadcasts a transaction; signing coordination is covered by the unit
// tests for the same storage lock.
const origin = process.env.HYPERION_BROWSER_URL ?? "http://127.0.0.1:3100";
const engine = process.env.HYPERION_BROWSER ?? "chromium";
const browserType = engine === "firefox" ? firefox : chromium;
const deployment = JSON.parse(
  await readFile(new URL("../src/config/testnet-deployment.json", import.meta.url), "utf8"),
);
const browser = await browserType.launch(
  process.env.HYPERION_BROWSER_EXECUTABLE
    ? { executablePath: process.env.HYPERION_BROWSER_EXECUTABLE }
    : {},
);
const context = await browser.newContext();
const first = await context.newPage();
const second = await context.newPage();
const pending = {
  router: deployment.networks["stellar-testnet"].router,
  account: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  destination: "sepolia",
  route: 1,
  bridgeAmount: "10000000",
  stage: "bridge",
  txHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};
try {
  await context.addInitScript((value) => {
    localStorage.setItem("hyperion.testnet.pending-transfer", JSON.stringify(value));
  }, pending);
  await first.goto(origin, { waitUntil: "domcontentloaded" });
  await second.goto(origin, { waitUntil: "domcontentloaded" });
  await second.getByRole("region", { name: "Transfer recovery" }).waitFor();
  await second.getByText("Reconnect GBBD47I...ZLLFLA5 to continue this transfer").waitFor();
  await first.close();
  await second.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await second.getByRole("button", { name: "Check status" }).count(), 1);
  assert.match(await second.locator("body").innerText(), /0123456789abcdef/);
  console.log("Browser fault harness passed: shared checkpoint survived tab closure.");
} finally {
  await context.close();
  await browser.close();
}

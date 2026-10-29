import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

// Run a local Next server first. This smoke check performs reads only and never signs.
const origin = process.env.HYPERION_BROWSER_URL ?? "http://127.0.0.1:3100";
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Send testnet USDC" }).waitFor();
  assert.equal(await page.getByLabel("Amount in USDC").count(), 1);
  assert.equal(await page.getByLabel("Recipient on Ethereum Sepolia").count(), 1);
  await page.getByLabel("Color theme").selectOption("dark");
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.getByLabel("Color theme").inputValue(), "dark");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.getByRole("button", { name: "Connect Stellar wallet", exact: true }).click();
  await page.getByText("Freighter", { exact: true }).waitFor();
  await page.getByText("Albedo", { exact: true }).waitFor();
  for (const route of ["/", "/transfers"]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}${route}`, { waitUntil: "networkidle" });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `Horizontal overflow on ${route}`,
    );
  }
  assert.deepEqual(errors, [], "Uncaught browser errors");
  console.log(
    "Browser smoke passed: transfer inputs, real wallet picker, history and mobile layout.",
  );
} finally {
  await browser.close();
}

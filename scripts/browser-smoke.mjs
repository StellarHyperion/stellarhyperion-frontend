import assert from "node:assert/strict";
import { chromium, firefox } from "@playwright/test";

// Run a local Next server first. This smoke check performs reads only and never signs.
const origin = process.env.HYPERION_BROWSER_URL ?? "http://127.0.0.1:3100";
const engine = process.env.HYPERION_BROWSER ?? "chromium";
if (engine !== "chromium" && engine !== "firefox")
  throw new Error("Choose chromium or firefox for HYPERION_BROWSER.");
const executablePath = process.env.HYPERION_BROWSER_EXECUTABLE;
const browser = await { chromium, firefox }[engine].launch(
  executablePath ? { executablePath } : {},
);
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Bridge assets" }).waitFor();
  assert.equal(await page.getByLabel("Amount to send").count(), 1);
  assert.equal(await page.getByLabel("Recipient on Ethereum Sepolia").count(), 1);
  const themeToggle = page.getByRole("button", { name: "Toggle dark theme" });
  if ((await themeToggle.getAttribute("aria-pressed")) !== "true") await themeToggle.click();
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await themeToggle.getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  assert.equal(await page.getByRole("button", { name: "Toggle dark theme" }).count(), 1);
  await page.getByRole("button", { name: "Choose source token", exact: true }).click();
  await page.getByRole("dialog", { name: "Choose a token" }).waitFor();
  await page.getByLabel("Search Stellar assets").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Choose destination network and token" }).click();
  for (const name of ["Ethereum Sepolia", "Base Sepolia", "Arc Testnet"])
    await page
      .getByRole("dialog")
      .getByRole("button", { name: new RegExp(name, "i") })
      .waitFor();
  await page.keyboard.press("Escape");
  assert.doesNotMatch(
    await page.locator("footer").innerText(),
    /Built by|Contracts|Backend|This app/,
  );
  assert.doesNotMatch(await page.locator("body").innerText(), /[\u2013\u2014]/);
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

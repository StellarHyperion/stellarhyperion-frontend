import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox } from "@playwright/test";

// Run a local Next server first. This smoke check performs reads only and never signs.
const origin = process.env.HYPERION_BROWSER_URL ?? "http://127.0.0.1:3100";
const engine = process.env.HYPERION_BROWSER ?? "chromium";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(
  await readFile(resolve(root, "src/config/testnet-deployment.json"), "utf8"),
);
const router = deployment.networks["stellar-testnet"].router;
if (engine !== "chromium" && engine !== "firefox")
  throw new Error("Choose chromium or firefox for HYPERION_BROWSER.");
const executablePath = process.env.HYPERION_BROWSER_EXECUTABLE;
const browser = await { chromium, firefox }[engine].launch(
  executablePath ? { executablePath } : {},
);
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  await page.addInitScript(() => {
    if (sessionStorage.getItem("wallet-preference-smoke-seeded")) return;
    sessionStorage.setItem("wallet-preference-smoke-seeded", "true");
    localStorage.setItem("hyperion.stellar.walletId", "albedo");
    localStorage.setItem("hyperion.testnet.pending-transfer", "unresolved-checkpoint");
  });
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
  await page.getByText("Remembered wallet: Albedo").waitFor();
  assert.equal(await page.getByRole("dialog", { name: "Connect a Stellar wallet" }).count(), 0);
  await page.getByRole("button", { name: "clear saved preference" }).click();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("hyperion.stellar.walletId")),
    null,
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("hyperion.testnet.pending-transfer")),
    "unresolved-checkpoint",
  );
  await page.getByRole("button", { name: "Choose source token", exact: true }).click();
  await page.getByRole("dialog", { name: "Choose a token" }).waitFor();
  await page.getByLabel("Search Stellar assets").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Choose destination network and token" }).click();
  const destinationDialog = page.getByRole("dialog", { name: "Choose a destination" });
  for (const name of ["Ethereum Sepolia", "Base Sepolia", "Arc Testnet"])
    await destinationDialog
      .getByRole("button", { name: new RegExp(name, "i") })
      .waitFor();
  const itsOption = destinationDialog.getByRole("button", { name: /USDC \(ITS\)/ });
  assert.equal(await itsOption.isEnabled(), true);
  for (const name of ["Base Sepolia", "Arc Testnet"]) {
    await destinationDialog.getByRole("button", { name: new RegExp(name, "i") }).click();
    assert.equal(await itsOption.isDisabled(), true);
  }
  await destinationDialog.getByRole("button", { name: /Ethereum Sepolia/i }).click();
  assert.equal(await itsOption.isEnabled(), true);
  await page.keyboard.press("Escape");
  assert.doesNotMatch(
    await page.locator("footer").innerText(),
    /Built by|Contracts|Backend|This app/,
  );
  assert.doesNotMatch(await page.locator("body").innerText(), /[\u2013\u2014]/);
  await page.getByRole("button", { name: "Connect Stellar wallet", exact: true }).click();
  await page.getByText("Freighter", { exact: true }).waitFor();
  await page.getByText("Albedo", { exact: true }).waitFor();
  const checkpoint = {
    router,
    account: "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA",
    recipient: "0x1111111111111111111111111111111111111111",
    destination: "sepolia",
    route: 1,
    bridgeAmount: "1000000",
    stage: "bridge",
    txHash: "a".repeat(64),
  };
  await page.evaluate((value) => {
    localStorage.setItem("hyperion.testnet.pending-transfer", JSON.stringify(value));
  }, checkpoint);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("region", { name: "Transfer recovery" }).waitFor();
  await page.getByText(`This recoverable operation belongs to ${checkpoint.account}.`).waitFor();
  assert.deepEqual(
    await page.evaluate(() => JSON.parse(localStorage.getItem("hyperion.testnet.pending-transfer"))),
    checkpoint,
  );
  await page.evaluate(() => localStorage.removeItem("hyperion.testnet.pending-transfer"));
  await page.reload({ waitUntil: "networkidle" });
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

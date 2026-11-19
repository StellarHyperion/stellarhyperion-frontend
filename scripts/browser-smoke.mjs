import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, firefox } from "@playwright/test";

// Run a local Next server first. This smoke check performs reads only and never signs.
const origin = process.env.HYPERION_BROWSER_URL ?? "http://127.0.0.1:3100";
const engine = process.env.HYPERION_BROWSER ?? "chromium";
if (engine !== "chromium" && engine !== "firefox")
  throw new Error("Choose chromium or firefox for HYPERION_BROWSER.");
const executablePath = process.env.HYPERION_BROWSER_EXECUTABLE;
const deployment = JSON.parse(
  await readFile(new URL("../src/config/testnet-deployment.json", import.meta.url), "utf8"),
);
const router =
  process.env.NEXT_PUBLIC_STELLAR_ROUTER?.trim() || deployment.networks["stellar-testnet"].router;
const browser = await { chromium, firefox }[engine].launch(
  executablePath ? { executablePath } : {},
);
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.addInitScript(() => {
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value) => (copied = value) },
    });
    Object.defineProperty(window, "__hyperionCopiedAddress", { get: () => copied });
  });
  const errors = [];
  await page.addInitScript(() => {
    if (sessionStorage.getItem("wallet-preference-smoke-seeded")) return;
    sessionStorage.setItem("wallet-preference-smoke-seeded", "true");
    localStorage.setItem("hyperion.stellar.walletId", "albedo");
    localStorage.setItem("hyperion.testnet.pending-transfer", "unresolved-checkpoint");
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.freighter = true;
    window.addEventListener("message", (event) => {
      if (
        typeof event.data === "object" &&
        event.data !== null &&
        event.data.source === "FREIGHTER_EXTERNAL_MSG_REQUEST"
      ) {
        if (event.data.type === "REQUEST_CONNECTION_STATUS") {
          window.postMessage(
            {
              source: "FREIGHTER_EXTERNAL_MSG_RESPONSE",
              messagedId: event.data.messageId,
              isConnected: true,
            },
            "*",
          );
        } else if (
          event.data.type === "REQUEST_ACCESS" ||
          event.data.type === "REQUEST_PUBLIC_KEY"
        ) {
          window.postMessage(
            {
              source: "FREIGHTER_EXTERNAL_MSG_RESPONSE",
              messagedId: event.data.messageId,
              publicKey: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
              address: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            },
            "*",
          );
        }
      }
    });
  });
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Bridge assets" }).waitFor();
  const identityDetails = page
    .locator("details")
    .filter({ hasText: "Inspect canonical USDC identity" });
  await identityDetails.locator("summary").click();
  const canonicalIssuer = deployment.networks["stellar-testnet"].tokens.USDC.issuer;
  assert.ok((await identityDetails.innerText()).includes(canonicalIssuer));
  assert.ok(
    (await identityDetails.innerText()).includes(
      deployment.networks["stellar-testnet"].tokens.USDC.sacId,
    ),
  );
  await identityDetails.getByRole("button", { name: "Copy canonical USDC issuer" }).click();
  await identityDetails.getByRole("status").filter({ hasText: "Copied" }).waitFor();
  assert.equal(await page.evaluate(() => window.__hyperionCopiedAddress), canonicalIssuer);
  assert.ok((await identityDetails.innerText()).includes("Axelar ITS USDC representation"));
  await page.getByRole("button", { name: "Choose destination network and token" }).click();
  const representationDialog = page.getByRole("dialog", { name: "Choose a destination" });
  await representationDialog
    .getByRole("button", { name: /Circle CCTP delivers native USDC/ })
    .click();
  assert.ok((await identityDetails.innerText()).includes("Circle CCTP native USDC"));

  // Opening a shared link loads bounded form state without any submission intent.
  const recipient = "0x" + "a".repeat(40);
  await page.goto(`${origin}?a=1&r=${recipient}&d=sepolia&t=0&s=native`, {
    waitUntil: "networkidle",
  });
  await page.getByLabel("Amount to send").waitFor();
  assert.strictEqual(await page.getByLabel("Amount to send").inputValue(), "1");
  assert.strictEqual(
    await page.getByLabel("Recipient on Ethereum Sepolia").inputValue(),
    recipient,
  );
  assert.ok((await page.getByLabel("Choose source token").textContent()).includes("XLM"));
  assert.ok(page.url().match(new RegExp(`\\?a=1&r=${recipient}&d=sepolia&t=0&s=native`)));
  // No checkpoint or automatic submission intent is restored from a shared link.
  assert.strictEqual(
    await page.getByRole("button", { name: /Bridge converted USDC|continue/i }).count(),
    0,
  );
  // Returning to (reloading) the link re-applies the bounded form state on mount: fresh lookup,
  // no stale submission intent carried over.
  await page.reload({ waitUntil: "networkidle" });
  assert.strictEqual(await page.getByLabel("Amount to send").inputValue(), "1");
  assert.strictEqual(
    await page.getByLabel("Recipient on Ethereum Sepolia").inputValue(),
    recipient,
  );
  assert.ok(page.url().match(new RegExp(`\\?a=1&r=${recipient}&d=sepolia&t=0&s=native`)));

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
  assert.equal(await page.evaluate(() => localStorage.getItem("hyperion.stellar.walletId")), null);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("hyperion.testnet.pending-transfer")),
    "unresolved-checkpoint",
  );
  await page.getByRole("button", { name: "Choose source token", exact: true }).click();
  const sourceDialog = page.getByRole("dialog", { name: "Choose a token" });
  await sourceDialog.waitFor();
  await page.getByLabel("Search Stellar assets").waitFor();
  await sourceDialog.getByText(/compare up to 50 Horizon paths by exact USDC output/i).waitFor();
  await page.getByLabel("Search Stellar assets").fill("USDC");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Choose destination network and token" }).click();
  const destinationDialog = page.getByRole("dialog", { name: "Choose a destination" });
  for (const name of ["Ethereum Sepolia", "Base Sepolia", "Arc Testnet"])
    await destinationDialog.getByRole("button", { name: new RegExp(name, "i") }).waitFor();
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
  const pickerDialog = page.getByRole("dialog", { name: "Connect a Stellar wallet" });
  await pickerDialog.waitFor();
  await pickerDialog.getByText("Freighter", { exact: true }).waitFor();
  await pickerDialog.getByText("Albedo", { exact: true }).waitFor();

  // Test typing a read-only address in the wallet picker dialog
  const readOnlyInput = pickerDialog.getByLabel("Stellar public address for read-only inspection");
  await readOnlyInput.waitFor();
  await readOnlyInput.fill("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
  await pickerDialog.getByRole("button", { name: "Inspect", exact: true }).click();
  await pickerDialog.waitFor({ state: "hidden" });
  const readOnlyButton = page.getByRole("button", { name: /GBBD47.*read-only/i });
  await readOnlyButton.waitFor();
  await readOnlyButton.click();
  const readOnlyDetails = page.getByRole("region", { name: "Wallet details" });
  await readOnlyDetails.waitFor();
  await readOnlyDetails.getByText("read-only inspection").waitFor();
  await readOnlyDetails.getByRole("button", { name: "Exit inspection" }).click();
  await readOnlyDetails.waitFor({ state: "hidden" });

  // Connect wallet and test mode mismatch prompt
  await page.getByRole("button", { name: "Connect Stellar wallet", exact: true }).click();
  await pickerDialog.waitFor();
  await pickerDialog.getByRole("button", { name: "Freighter", exact: true }).click();
  await pickerDialog.waitFor({ state: "hidden" });
  const connectedButton = page.getByRole("button", { name: /GA5ZSE.*testnet/i });
  await connectedButton.waitFor();
  await connectedButton.click();
  const connectedDetails = page.getByRole("region", { name: "Wallet details" });
  await connectedDetails.waitFor();

  // Type a different address while connected to trigger mode mismatch reconciliation prompt
  const menuInspectInput = connectedDetails.getByLabel("Stellar address to inspect");
  await menuInspectInput.waitFor();
  await menuInspectInput.fill("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
  await connectedDetails.getByRole("button", { name: "Inspect", exact: true }).click();

  const reconciliationRegion = page.getByRole("region", { name: "Mode reconciliation" });
  await reconciliationRegion.waitFor();
  await reconciliationRegion.getByText("Mode reconciliation required").waitFor();
  assert.equal(
    await reconciliationRegion.getByRole("button", { name: "Use connected wallet" }).count(),
    1,
  );
  assert.equal(
    await reconciliationRegion.getByRole("button", { name: "Keep read-only" }).count(),
    1,
  );

  // Keep read-only mode to reconcile
  await reconciliationRegion.getByRole("button", { name: "Keep read-only" }).click();
  assert.equal(await page.getByRole("region", { name: "Mode reconciliation" }).count(), 0);
  await connectedDetails.getByText("read-only inspection").waitFor();
  await connectedDetails.getByRole("button", { name: "Exit inspection" }).click();
  await connectedDetails.waitFor({ state: "hidden" });
  await page.evaluate((router) => {
    localStorage.setItem(
      "hyperion.testnet.pending-transfer",
      JSON.stringify({
        router,
        account: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
        destination: "sepolia",
        route: 1,
        bridgeAmount: "10000000",
        stage: "bridge",
        txHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      }),
    );
    window.dispatchEvent(new Event("hyperion:pending-transfer"));
  }, router);
  await page.getByRole("region", { name: "Transfer recovery" }).waitFor();
  await page.getByText("Reconnect GBBD47I...ZLLFLA5 to continue this transfer").waitFor();
  await page
    .getByText(
      "This saved signed hash does not establish broadcast or confirmation. Check its source status before approving another transfer.",
    )
    .waitFor();
  await page.getByRole("button", { name: "Check status" }).waitFor();
  const checkpointBeforeNavigation = await page.evaluate(() =>
    localStorage.getItem("hyperion.testnet.pending-transfer"),
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("region", { name: "Transfer recovery" }).waitFor();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("hyperion.testnet.pending-transfer")),
    checkpointBeforeNavigation,
  );
  assert.equal(
    await page.getByRole("link", { name: "Recovery" }).getAttribute("href"),
    "/#pending-recovery",
  );
  await page.waitForFunction(() => document.activeElement?.id === "pending-recovery-action");
  await page.getByRole("link", { name: "Activity" }).click();
  await page.getByRole("heading", { name: "Transfer history" }).waitFor();
  await page.getByRole("link", { name: "Recovery" }).click();
  await page.getByRole("region", { name: "Transfer recovery" }).waitFor();
  await page.waitForFunction(() => document.activeElement?.id === "pending-recovery-action");
  // Selecting the current recovery fragment again restores focus without resetting its identity.
  await page.getByRole("link", { name: "Activity" }).focus();
  await page.getByRole("link", { name: "Recovery" }).click();
  await page.waitForFunction(() => document.activeElement?.id === "pending-recovery-action");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("hyperion.testnet.pending-transfer")),
    checkpointBeforeNavigation,
  );
  const otherTab = await page.context().newPage();
  await otherTab.goto(origin, { waitUntil: "domcontentloaded" });
  await otherTab.evaluate(() => {
    const checkpoint = JSON.parse(localStorage.getItem("hyperion.testnet.pending-transfer"));
    localStorage.setItem(
      "hyperion.testnet.pending-transfer",
      JSON.stringify({ ...checkpoint, txHash: "f".repeat(64) }),
    );
  });
  await page
    .getByRole("region", { name: "Transfer recovery" })
    .getByRole("link", { name: /f{12}\.\.\.f{8}/ })
    .waitFor();
  await otherTab.close();
  await page.evaluate(() => {
    localStorage.removeItem("hyperion.testnet.pending-transfer");
    window.dispatchEvent(new Event("hyperion:pending-transfer"));
  });
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
    "Browser smoke passed: transfer inputs, shared links, cancel/resume boundary, real wallet picker, history and mobile layout.",
  );
} finally {
  await browser.close();
}

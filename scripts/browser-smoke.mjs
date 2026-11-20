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
  // This smoke check only reads and never signs. Catch any accidental live submission network
  // call (a Soroban RPC POST or an outbound Horizon transaction broadcast) so a change that makes
  // this read-only pass start spending testnet funds fails loudly instead of going unnoticed.
  // Matching is done against the parsed hostname (never an unanchored substring test against the
  // full URL), so an attacker-controlled URL like https://evil.com/soroban-testnet.stellar.org or
  // https://soroban-testnet.stellar.org.evil.com cannot be mistaken for the real testnet host.
  const submissionCalls = [];
  const submissionHostname = (url) => {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  };
  page.on("request", (request) => {
    const url = request.url();
    const hostname = submissionHostname(url);
    if (
      request.method() === "POST" &&
      (hostname === "soroban-testnet.stellar.org" ||
        (hostname === "horizon-testnet.stellar.org" &&
          new URL(url).pathname.includes("/transactions")))
    )
      submissionCalls.push(url);
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
  await page.getByText("Freighter", { exact: true }).waitFor();
  await page.getByText("Albedo", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
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
  // Verify wallet network change detection and wrong network blocking in browser.
  const networkPage = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  networkPage.on("pageerror", (error) => errors.push(error.message));
  await networkPage.addInitScript(() => {
    window.freighter = true;
    window.__freighterNetwork = "Public Global Stellar Network ; September 2015";
    window.addEventListener("message", (event) => {
      const data = event.data;
      if (data && data.source === "FREIGHTER_EXTERNAL_MSG_REQUEST") {
        if (data.type === "REQUEST_CONNECTION_STATUS") {
          window.postMessage(
            {
              source: "FREIGHTER_EXTERNAL_MSG_RESPONSE",
              messagedId: data.messageId,
              isConnected: true,
              data: { isConnected: true },
            },
            window.location.origin,
          );
        } else if (data.type === "REQUEST_ACCESS" || data.type === "REQUEST_PUBLIC_KEY") {
          window.postMessage(
            {
              source: "FREIGHTER_EXTERNAL_MSG_RESPONSE",
              messagedId: data.messageId,
              publicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
              address: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
              data: {
                publicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
                address: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
              },
            },
            window.location.origin,
          );
        } else if (data.type === "REQUEST_NETWORK_DETAILS") {
          const details = {
            network: window.__freighterNetwork.includes("Test") ? "TESTNET" : "PUBLIC",
            networkPassphrase: window.__freighterNetwork,
            networkUrl: "https://horizon-testnet.stellar.org",
          };
          window.postMessage(
            {
              source: "FREIGHTER_EXTERNAL_MSG_RESPONSE",
              messagedId: data.messageId,
              networkDetails: details,
              ...details,
              data: {
                networkDetails: details,
                ...details,
              },
            },
            window.location.origin,
          );
        }
      }
    });
  });
  await networkPage.goto(origin, { waitUntil: "networkidle" });
  await networkPage.getByRole("button", { name: "Connect Stellar wallet", exact: true }).click();
  await networkPage.getByRole("button", { name: "Freighter" }).click();
  await networkPage.getByText("(wrong network)").waitFor();
  await networkPage
    .getByText("Switch Freighter to Stellar Testnet before signing.")
    .first()
    .waitFor();
  // Switching wallet network to Testnet updates the status and clears the warning.
  await networkPage.evaluate(() => {
    window.__freighterNetwork = "Test SDF Network ; September 2015";
  });
  await networkPage.getByText("(testnet)").waitFor();
  await networkPage.close();

  // Touch targets and small screens. The dialog body scrolls while its close control and the
  // recovery action stay inside the viewport, long amounts and hashes never overlap the controls
  // beside them, and 320 by 640 CSS pixels stands in for a 640 pixel window at 200 percent zoom.
  const box = (locator) =>
    locator.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
      };
    });
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 640 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Bridge assets" }).waitFor();
    await page.getByLabel("Amount to send").fill("123456789.1234567");
    const amountBox = await box(page.getByLabel("Amount to send"));
    const tokenBox = await box(
      page.getByRole("button", { name: "Choose source token", exact: true }),
    );
    assert.ok(
      amountBox.bottom <= tokenBox.top + 0.5 || amountBox.right <= tokenBox.left + 0.5,
      `Long amount overlaps the token selector at ${viewport.width}px`,
    );
    await page.getByRole("button", { name: "Choose source token", exact: true }).click();
    const tokenDialog = page.getByRole("dialog", { name: "Choose a token" });
    await tokenDialog.waitFor();
    const tokenDialogBox = await box(tokenDialog);
    assert.ok(
      tokenDialogBox.left >= 0 && tokenDialogBox.right <= viewport.width + 0.5,
      `Dialog overflows the narrow viewport at ${viewport.width}px`,
    );
    assert.ok(
      tokenDialogBox.top >= 0 && tokenDialogBox.bottom <= viewport.height + 0.5,
      `Dialog exceeds the viewport height at ${viewport.width}px`,
    );
    const closeBox = await box(tokenDialog.getByRole("button", { name: "Close selector" }));
    assert.ok(closeBox.width >= 40 && closeBox.height >= 40, "Dialog close target below 44px");
    assert.ok(
      closeBox.top >= 0 && closeBox.bottom <= viewport.height + 0.5,
      `Dialog close control outside the viewport at ${viewport.width}px`,
    );
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });

    // A saved recovery identity with a long hash and amount keeps its action and copy control
    // separate from the wrapping text.
    await page.evaluate((router) => {
      localStorage.setItem(
        "hyperion.testnet.pending-transfer",
        JSON.stringify({
          router,
          account: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
          recipient: "0x" + "b".repeat(40),
          destination: "sepolia",
          route: 1,
          bridgeAmount: "123456789012345",
          stage: "bridge",
          txHash: "a".repeat(64),
        }),
      );
      window.dispatchEvent(new Event("hyperion:pending-transfer"));
    }, router);
    const recovery = page.getByRole("region", { name: "Transfer recovery" });
    await recovery.waitFor();
    const hashBox = await box(recovery.locator("code").first());
    const copyBox = await box(recovery.getByRole("button", { name: "Copy transaction hash" }));
    assert.ok(
      copyBox.top >= hashBox.bottom - 0.5 || copyBox.left >= hashBox.right - 0.5,
      `Transaction hash overlaps its copy control at ${viewport.width}px`,
    );
    const statusAction = recovery.getByRole("button", { name: "Check status" });
    await statusAction.scrollIntoViewIfNeeded();
    const statusBox = await box(statusAction);
    assert.ok(statusBox.height >= 40, "Recovery action below the touch target minimum");
    assert.ok(
      statusBox.top >= 0 && statusBox.bottom <= viewport.height + 0.5,
      `Recovery action stays out of reach at ${viewport.width}px`,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `Horizontal overflow with a long hash at ${viewport.width}px`,
    );
    await page.evaluate(() => {
      localStorage.removeItem("hyperion.testnet.pending-transfer");
      window.dispatchEvent(new Event("hyperion:pending-transfer"));
    });
  }
  assert.deepEqual(errors, [], "Uncaught browser errors");
  assert.deepEqual(
    submissionCalls,
    [],
    "This read-only smoke check must never submit or broadcast a signed transaction.",
  );
  console.log(
    "Browser smoke passed: transfer inputs, shared links, cancel/resume boundary, real wallet picker, network detection, history, mobile layout and no live submission calls.",
  );
} finally {
  await browser.close();
}

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
    window.__hyperionCspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__hyperionCspViolations.push({
        directive: event.effectiveDirective,
        blockedURI: event.blockedURI,
      });
    });
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
  const fixtureVersions = {
    freighter: "mock-freighter/1.0",
    albedo: "mock-albedo/1.0",
    xbull: "mock-xbull/1.0",
    lobstr: "mock-lobstr/1.0",
  };
  const walletFixture = await page.evaluate(async (versions) => {
    const events = [];
    let pending = null;
    const run = async (request, action) => {
      if (pending) throw new Error("duplicate approval");
      pending = request;
      events.push(`pending:${request.adapter}`);
      try {
        return await action();
      } finally {
        pending = null;
        events.push(`released:${request.adapter}`);
      }
    };

    await run({ adapter: "albedo" }, async () => {
      throw new Error("popup closed");
    }).catch((error) => {
      if (error.message !== "popup closed") throw error;
    });
    const retry = await run({ adapter: "albedo" }, async () => "signed-intent");
    await run({ adapter: "freighter" }, async () => {
      throw new Error("User rejected");
    }).catch((error) => {
      if (error.message !== "User rejected") throw error;
    });
    return { retry, events, versions };
  }, fixtureVersions);
  assert.deepEqual(walletFixture.events, [
    "pending:albedo",
    "released:albedo",
    "pending:albedo",
    "released:albedo",
    "pending:freighter",
    "released:freighter",
  ]);
  assert.equal(walletFixture.retry, "signed-intent");
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Bridge assets" }).waitFor();
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.src = "https://unexpected-script.invalid/fixture.js";
    document.head.append(script);
    const inline = document.createElement("script");
    inline.textContent = "window.__hyperionUnexpectedInlineScript = true";
    document.head.append(inline);
    void fetch("https://unexpected-connect.invalid/fixture", { mode: "no-cors" }).catch(() => {});
  });
  await page.waitForFunction(
    () =>
      window.__hyperionCspViolations.some((violation) =>
        violation.blockedURI.includes("unexpected-script.invalid"),
      ) &&
      window.__hyperionCspViolations.some(
        (violation) =>
          violation.directive === "script-src-elem" || violation.directive === "script-src",
      ) &&
      window.__hyperionCspViolations.some((violation) =>
        violation.blockedURI.includes("unexpected-connect.invalid"),
      ),
  );
  assert.equal(await page.evaluate(() => window.__hyperionUnexpectedInlineScript), undefined);
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
  const exactAmount = "900719925.4740993";
  const sharedLink = `${origin}?a=${exactAmount}&r=${recipient}&d=sepolia&t=0&s=native`;
  await page.goto(sharedLink, { waitUntil: "networkidle" });
  await page.getByLabel("Amount to send").waitFor();
  assert.strictEqual(await page.getByLabel("Amount to send").inputValue(), exactAmount);
  assert.strictEqual(
    await page.getByLabel("Recipient on Ethereum Sepolia").inputValue(),
    recipient,
  );
  assert.ok((await page.getByLabel("Choose source token").textContent()).includes("XLM"));
  assert.strictEqual(new URL(page.url()).searchParams.get("a"), exactAmount);
  assert.strictEqual(new URL(page.url()).searchParams.get("s"), "native");
  // No checkpoint or automatic submission intent is restored from a shared link.
  assert.strictEqual(
    await page.getByRole("button", { name: /Bridge converted USDC|continue/i }).count(),
    0,
  );
  // Returning to (reloading) the link re-applies the bounded form state on mount: fresh lookup,
  // no stale submission intent carried over.
  await page.getByLabel("Amount to send").fill("1.23456789");
  assert.strictEqual(await page.getByLabel("Amount to send").inputValue(), "1.23456789");
  await page.goto(sharedLink, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });
  assert.strictEqual(await page.getByLabel("Amount to send").inputValue(), exactAmount);
  assert.strictEqual(
    await page.getByLabel("Recipient on Ethereum Sepolia").inputValue(),
    recipient,
  );
  assert.strictEqual(new URL(page.url()).searchParams.get("a"), exactAmount);
  assert.strictEqual(new URL(page.url()).searchParams.get("s"), "native");

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
  // Reduced motion: the dialog opens as a static state and its status text stays readable.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Choose source token", exact: true }).click();
  const reducedDialog = page.getByRole("dialog", { name: "Choose a token" });
  await reducedDialog.waitFor();
  assert.equal(
    await reducedDialog.evaluate((node) => getComputedStyle(node).animationName),
    "none",
  );
  await reducedDialog
    .getByRole("status")
    .filter({ hasText: "Showing USDC, XLM and wallet assets." })
    .waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.emulateMedia({ reducedMotion: "no-preference" });
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
  for (const walletName of ["Freighter", "Albedo", "xBull", "LOBSTR"])
    await page.getByRole("dialog").getByText(walletName, { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
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
  await page.evaluate((checkpoint) => {
    localStorage.setItem("hyperion.testnet.pending-transfer", checkpoint);
  }, checkpointBeforeNavigation);
  for (const viewport of [
    { width: 640, height: 900, label: "desktop at 200% zoom" },
    { width: 320, height: 844, label: "mobile at 200% zoom" },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.getByRole("region", { name: "Transfer recovery" }).waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `Horizontal overflow at ${viewport.label}`,
    );
    const recovery = page.getByRole("region", { name: "Transfer recovery" });
    assert.equal(
      await recovery.locator("code").textContent(),
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      `Full source hash remains inspectable at ${viewport.label}`,
    );
    const recoveryAction = recovery.getByRole("button", { name: "Check status" });
    await recoveryAction.scrollIntoViewIfNeeded();
    const actionBounds = await recoveryAction.boundingBox();
    assert.ok(
      actionBounds &&
        actionBounds.x >= 0 &&
        actionBounds.x + actionBounds.width <= viewport.width,
      `Recovery action fits the viewport at ${viewport.label}`,
    );
    await page.getByRole("button", { name: "Choose source token", exact: true }).click();
    const zoomDialog = page.getByRole("dialog", { name: "Choose a token" });
    await zoomDialog.waitFor();
    const dialogBounds = await zoomDialog.evaluate((element) => {
      const { left, right } = element.getBoundingClientRect();
      return { left, right, width: window.innerWidth };
    });
    assert.ok(
      dialogBounds.left >= 0 && dialogBounds.right <= dialogBounds.width,
      `Token picker fits the viewport at ${viewport.label}`,
    );
    await page.keyboard.press("Escape");
    await page.getByText("Recover a Stellar claim", { exact: true }).click();
    await page.getByLabel("Claim number").waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `Claim recovery form has no horizontal overflow at ${viewport.label}`,
    );
  }
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
    `Browser smoke passed (${engine} ${browser.version()}): transfer inputs, deterministic mock wallet cancellation/popup loss, real wallet picker, history and mobile layout. Adapter fixtures: ${Object.entries(
      walletFixture.versions,
    )
      .map(([name, version]) => `${name}=${version}`)
      .join(", ")}`,
  );
} finally {
  await browser.close();
}

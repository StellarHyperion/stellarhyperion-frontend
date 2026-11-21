import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, firefox } from "@playwright/test";

// Run a local Next server first. Fixtures exercise read-only recovery and never sign.
const origin = process.env.HYPERION_BROWSER_URL ?? "http://127.0.0.1:3100";
const engine = process.env.HYPERION_BROWSER ?? "chromium";
if (engine !== "chromium" && engine !== "firefox")
  throw new Error("Choose chromium or firefox for HYPERION_BROWSER.");
const executablePath = process.env.HYPERION_BROWSER_EXECUTABLE;
const browser = await { chromium, firefox }[engine].launch(
  executablePath ? { executablePath } : {},
);
const evidenceDir =
  process.env.HYPERION_BROWSER_ARTIFACTS ?? path.join(tmpdir(), "hyperion-browser-audit");
await mkdir(evidenceDir, { recursive: true });
const auditResults = [];
let transactionFixture = "NOT_FOUND";

function expectAudit(condition, control, expectation, actual) {
  const result = {
    control,
    expectation,
    passed: Boolean(condition),
    actual: String(actual),
  };
  auditResults.push(result);
  if (!condition) {
    throw new Error(
      `Browser audit failed for "${control}": expected ${expectation}; observed ${actual}.`,
    );
  }
}

async function capture(page, name, control) {
  const ariaSnapshot = await page.locator("body").ariaSnapshot();
  const focusedControl = await page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return null;
    const labelledBy = element.getAttribute("aria-labelledby");
    const labelText = labelledBy
      ? labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
          .filter(Boolean)
          .join(" ")
      : "";
    return {
      tagName: element.tagName,
      role: element.getAttribute("role"),
      accessibleName:
        element.getAttribute("aria-label") ||
        labelText ||
        element.innerText?.trim() ||
        element.getAttribute("placeholder") ||
        "",
    };
  });
  const base = path.join(evidenceDir, name);
  await page.screenshot({ path: `${base}.png`, fullPage: true });
  await writeFile(
    `${base}.json`,
    JSON.stringify({ control, focusedControl, ariaSnapshot }, null, 2),
  );
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    let payload;
    try {
      payload = route.request().postDataJSON();
    } catch {
      payload = null;
    }
    if (payload?.method === "getNetwork") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            friendbotUrl: "https://friendbot.stellar.org/",
            passphrase: "Test SDF Network ; September 2015",
            protocolVersion: 23,
          },
        }),
      });
      return;
    }
    if (payload?.method === "getTransaction") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            status: transactionFixture,
            latestLedger: 2,
            latestLedgerCloseTime: "2026-01-01T00:00:00Z",
            oldestLedger: 1,
            oldestLedgerCloseTime: "2026-01-01T00:00:00Z",
            ledger: 2,
            createdAt: "2026-01-01T00:00:00Z",
            applicationOrder: 1,
            feeBump: false,
            envelopeXdr: "",
            resultXdr: "",
            resultMetaXdr: "",
          },
        }),
      });
      return;
    }
    if (
      route.request().method() === "GET" &&
      new URL(route.request().url()).pathname.endsWith("/assets")
    ) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          _embedded: {
            records: [
              {
                asset_code: "TST",
                asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
              },
              {
                asset_code: "TST",
                asset_issuer: "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA",
              },
            ],
          },
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Bridge assets" }).waitFor();
  const amountInput = page.getByLabel("Amount to send");
  await amountInput.fill("0.0000001");
  expectAudit(
    (await amountInput.inputValue()) === "0.0000001",
    "Amount to send",
    "preserves the entered seven-decimal integer amount exactly",
    await amountInput.inputValue(),
  );
  await amountInput.fill("");
  expectAudit(
    (await amountInput.count()) === 1,
    "Amount to send",
    "has one accessible input",
    await amountInput.count(),
  );
  expectAudit(
    (await page.getByLabel("Recipient on Ethereum Sepolia").count()) === 1,
    "Recipient on Ethereum Sepolia",
    "has one accessible input",
    await page.getByLabel("Recipient on Ethereum Sepolia").count(),
  );

  const sourceTrigger = page.getByRole("button", {
    name: "Choose source token",
    exact: true,
  });
  await sourceTrigger.click();
  const sourceDialog = page.getByRole("dialog", { name: "Choose a token" });
  await sourceDialog.waitFor();
  const search = page.getByRole("textbox", { name: "Search Stellar assets" });
  await search.waitFor();
  expectAudit(
    await search.evaluate((element) => element === document.activeElement),
    "Search Stellar assets",
    "receives focus when its dialog opens",
    await page.evaluate(() => document.activeElement?.outerHTML ?? "no focused element"),
  );
  expectAudit(
    (await sourceDialog.getByRole("button", { name: "Close Choose a token" }).count()) === 1,
    "Close Choose a token",
    "has a dialog-specific accessible name",
    await sourceDialog.getByRole("button").allTextContents(),
  );
  await search.fill("TST");
  await sourceDialog.getByRole("button", { name: /TST/ }).first().waitFor();
  const inspectedAssets = sourceDialog.locator("details");
  expectAudit(
    (await inspectedAssets.count()) === 2,
    "TST source token results",
    "keeps duplicate symbols as separate issuer-specific assets",
    await sourceDialog.getByRole("button").allTextContents(),
  );
  const issuers = [];
  for (let index = 0; index < 2; index++) {
    const details = inspectedAssets.nth(index);
    await details.locator("summary").click();
    issuers.push(await details.locator("dd").first().innerText());
  }
  expectAudit(
    issuers[0] !== issuers[1],
    "TST source token identities",
    "exposes distinct issuers for assets with the same symbol",
    issuers.join(", "),
  );
  await capture(page, "token-picker", "Choose a token dialog");
  await sourceDialog.getByRole("button", { name: /TST/ }).first().click();
  await sourceDialog.waitFor({ state: "hidden" });
  const selectedIssuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const issuerLink = page.getByRole("link", {
    name: `Issuer: ${selectedIssuer.slice(0, 7)}...${selectedIssuer.slice(-7)}`,
  });
  expectAudit(
    (await issuerLink.getAttribute("href"))?.endsWith(`TST-${selectedIssuer}`),
    "Selected TST issuer link",
    "retains the selected issuer when the asset is chosen",
    await issuerLink.getAttribute("href"),
  );
  const selectedSource = await sourceTrigger.innerText();
  await sourceTrigger.click();
  await page.getByRole("dialog", { name: "Choose a token" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Choose a token" }).waitFor({ state: "hidden" });
  expectAudit(
    await sourceTrigger.evaluate((element) => element === document.activeElement),
    "Choose source token",
    "regains focus after dialog cancellation",
    await page.evaluate(() => document.activeElement?.outerHTML ?? "no focused element"),
  );
  expectAudit(
    (await sourceTrigger.innerText()) === selectedSource,
    "Choose source token",
    "keeps the previous source when the picker is cancelled",
    await sourceTrigger.innerText(),
  );
  await capture(page, "cancelled-source-picker", "Cancelled source token selection");

  await page.getByRole("button", { name: "Choose destination network and token" }).click();
  const destinationDialog = page.getByRole("dialog", { name: "Choose a destination" });
  await destinationDialog.waitFor();
  for (const name of ["Ethereum Sepolia", "Base Sepolia", "Arc Testnet"])
    await destinationDialog
      .getByRole("button", { name: new RegExp(name, "i") })
      .waitFor();
  await destinationDialog.getByRole("button", { name: /Base Sepolia/i }).click();
  const cctpOption = destinationDialog.getByRole("button", {
    name: /Native USDC via Circle CCTP/,
  });
  const itsOption = destinationDialog.getByRole("button", { name: /USDC \(ITS\)/ });
  expectAudit(
    !(await cctpOption.isDisabled()),
    "Base Sepolia USDC via Circle CCTP",
    "remains selectable on a configured CCTP testnet lane",
    `disabled=${await cctpOption.isDisabled()}`,
  );
  expectAudit(
    await itsOption.isDisabled(),
    "Base Sepolia USDC (ITS)",
    "is unavailable where the ITS lane is not configured",
    `disabled=${await itsOption.isDisabled()}`,
  );
  await destinationDialog.getByRole("button", { name: /Arc Testnet/i }).click();
  expectAudit(
    !(await cctpOption.isDisabled()),
    "Arc Testnet USDC via Circle CCTP",
    "remains selectable on a configured CCTP testnet lane",
    `disabled=${await cctpOption.isDisabled()}`,
  );
  expectAudit(
    await itsOption.isDisabled(),
    "Arc Testnet USDC (ITS)",
    "is unavailable where the ITS lane is not configured",
    `disabled=${await itsOption.isDisabled()}`,
  );
  await capture(page, "destination-picker", "Choose a destination dialog");
  await page.keyboard.press("Escape");
  await destinationDialog.waitFor({ state: "hidden" });
  expectAudit(
    (await page.getByRole("button", { name: "Choose destination network and token" }).innerText())
      .includes("Ethereum Sepolia"),
    "Choose destination network and token",
    "keeps the previous destination when the picker is cancelled",
    await page.getByRole("button", { name: "Choose destination network and token" }).innerText(),
  );
  expectAudit(
    (await page.locator("footer").innerText()).match(/Built by|Contracts|Backend|This app/) ===
      null,
    "Footer",
    "contains no internal implementation details",
    await page.locator("footer").innerText(),
  );
  expectAudit(
    !/[\u2013\u2014]/.test(await page.locator("body").innerText()),
    "Bridge page copy",
    "avoids ambiguous dash glyphs in the accessible content",
    "body text inspected",
  );

  const connectButton = page.getByRole("button", {
    name: "Connect Stellar wallet",
    exact: true,
  });
  await connectButton.click();
  const walletDialog = page.getByRole("dialog", { name: "Connect a Stellar wallet" });
  await walletDialog.waitFor();
  await page.getByText("Freighter", { exact: true }).waitFor();
  await page.getByText("Albedo", { exact: true }).waitFor();
  await capture(page, "wallet-picker", "Wallet connection approval");
  await page.keyboard.press("Escape");
  await walletDialog.waitFor({ state: "hidden" });
  expectAudit(
    await connectButton.isVisible(),
    "Connect Stellar wallet",
    "remains unconnected after wallet-picker cancellation",
    await connectButton.innerText(),
  );
  await capture(page, "cancelled-wallet-picker", "Cancelled wallet connection");

  const fixture = {
    router: "CCXPCT3YFLVANSF3AQMYCCZVGCMLTURAYQ6O6DYGQJMTKVYQL6NTOC2V",
    account: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    destination: "sepolia",
    route: 1,
    bridgeAmount: "10000000",
    stage: "bridge",
  };
  async function seedCheckpoint(router, suffix) {
    const checkpoint = {
      ...fixture,
      router,
      txHash: suffix.repeat(64),
    };
    await page.evaluate((value) => {
      localStorage.setItem("hyperion.testnet.pending-transfer", JSON.stringify(value));
      window.dispatchEvent(new Event("hyperion:pending-transfer"));
    }, checkpoint);
  }

  await seedCheckpoint(
    "CDMOLDF4SJDEDRWTDF7XAYMSRE6L3YEHHIRF57CFWNQYNC6ZOZ5LWCWF",
    "0",
  );
  const recovery = page.getByRole("region", { name: "Transfer recovery" });
  await recovery.waitFor();
  await page.getByText("Reconnect GBBD47I...ZLLFLA5 to continue this transfer").waitFor();
  await page.getByText("Archived router:", { exact: false }).waitFor();
  await page.getByRole("link", { name: "Inspect successor deployment" }).waitFor();
  expectAudit(
    await page
      .getByRole("button", { name: "Continue unavailable for this router" })
      .isDisabled(),
    "Continue unavailable for this router",
    "cannot submit a checkpoint against an archived router",
    "button disabled state",
  );
  await page.getByRole("button", { name: "Check status" }).waitFor();
  await capture(page, "archived-recovery", "Archived transfer recovery");

  async function auditTransactionState(status, heading, screenshotName, expectedText) {
    transactionFixture = status;
    const hashSuffix = status === "NOT_FOUND" ? "1" : status === "FAILED" ? "2" : "3";
    await seedCheckpoint(fixture.router, hashSuffix);
    const card = page.getByRole("region", { name: "Transfer recovery" });
    await card.getByRole("button", { name: "Check status" }).click();
    const statusHeading = card.getByRole("heading", { name: heading });
    await statusHeading.waitFor();
    const actualText = await card.innerText();
    expectAudit(
      actualText.includes(expectedText),
      heading,
      `reports ${expectedText}`,
      actualText,
    );
    if (status === "SUCCESS") {
      expectAudit(
        (await card.getByRole("link", { name: "Track transfer" }).count()) === 1,
        "Track transfer",
        "is available after Stellar source confirmation",
        await card.getByRole("link").allTextContents(),
      );
    }
    if (status === "NOT_FOUND") {
      expectAudit(
        (await card.getByRole("button").allTextContents()).join(" ") === "Check status",
        "Check status",
        "does not resubmit or request wallet approval while the source outcome is unknown",
        await card.getByRole("button").allTextContents(),
      );
    }
    await capture(page, screenshotName, heading);
  }

  await auditTransactionState(
    "SUCCESS",
    "Transfer confirmed on Stellar",
    "source-confirmed",
    "A Stellar confirmation starts the bridge journey.",
  );
  await auditTransactionState(
    "FAILED",
    "Transaction failed on Stellar",
    "transaction-failed",
    "Transaction failed on Stellar",
  );
  await auditTransactionState(
    "NOT_FOUND",
    "Transaction outcome unknown",
    "transaction-outcome-unknown",
    "has not confirmed a final transaction result yet",
  );

  await seedCheckpoint(
    "GDXRQQETEZHGRJTE3U7DYGIWGGYGMM6EAS5NWGPGN2WXFXZYZ6QZIANA",
    "4",
  );
  const unknownRouter = page.getByRole("region", { name: "Transfer recovery" });
  await unknownRouter.waitFor();
  const unknownRouterMessage = unknownRouter.getByText(
    "This checkpoint references an unrecognized router",
    { exact: false },
  );
  await unknownRouterMessage.waitFor();
  expectAudit(
    (await unknownRouter.getByRole("button", { name: "Check status" }).count()) === 0,
    "Check status",
    "is not offered for an unknown source router",
    await unknownRouter.getByRole("button").allTextContents(),
  );
  await capture(page, "unknown-source-router", "Unknown source router recovery");

  await page.evaluate(() => {
    localStorage.removeItem("hyperion.testnet.pending-transfer");
    window.dispatchEvent(new Event("hyperion:pending-transfer"));
  });
  for (const route of ["/", "/transfers"]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}${route}`, { waitUntil: "networkidle" });
    expectAudit(
      !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)),
      route,
      "has no horizontal overflow at a mobile viewport",
      `${await page.evaluate(() => document.documentElement.scrollWidth)}px document width`,
    );
  }
  expectAudit(errors.length === 0, "Browser runtime", "has no uncaught errors", errors.join("; "));
  await writeFile(
    path.join(evidenceDir, "audit-report.json"),
    JSON.stringify(auditResults, null, 2),
  );
  console.log(
    `Browser audit passed: ${auditResults.length} checks. Evidence: ${evidenceDir}`,
  );
} catch (error) {
  await writeFile(
    path.join(evidenceDir, "audit-report.json"),
    JSON.stringify({ checks: auditResults, failure: String(error) }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import ts from "typescript";
import { chromium, firefox, expect } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";

// Real tabs import production coordination, checkpoint, cryptographic verifier and submission.
// The RPC transport and generated local wallet signer are fixture boundaries.
const engine = process.env.HYPERION_BROWSER ?? "chromium";
if (engine !== "chromium" && engine !== "firefox") throw new Error("Choose chromium or firefox.");
const root = fileURLToPath(new URL("..", import.meta.url)),
  scratch = await mkdtemp(path.join(tmpdir(), "hyperion-coordination-")),
  pair = Keypair.random(),
  evidence = process.env.HYPERION_RECOVERY_EVIDENCE_DIR;
const files = [
  "src/contracts/checkpoint.ts",
  "src/components/bridge/Bridge.tsx",
  "src/lib/format.ts",
  "src/contracts/stellar.ts",
  "src/wallets/stellar/signature.ts",
  "src/components/transfers/TransferList.tsx",
];
const sources = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => [
      file,
      createHash("sha256")
        .update(await readFile(path.join(root, file)))
        .digest("hex"),
    ]),
  ),
);
let server, browser;
const trace = [];
try {
  const entry = path.join(scratch, "entry.mjs");
  await writeFile(
    entry,
    `
import React from ${JSON.stringify(path.join(root, "node_modules/react/index.js"))};
import {createRoot} from ${JSON.stringify(path.join(root, "node_modules/react-dom/client.js"))};
import {Account,Asset,Keypair,Operation,TransactionBuilder,rpc} from '@stellar/stellar-sdk';
import {acquireOperationOwnership,getOperationOwnership,getTransferCheckpoint,saveCheckpoint} from ${JSON.stringify(path.join(root, "src/contracts/checkpoint.ts"))};
import {submitClassicOperations} from ${JSON.stringify(path.join(root, "src/contracts/stellar.ts"))};
import {verifyWalletSignature} from ${JSON.stringify(path.join(root, "src/wallets/stellar/signature.ts"))};
import {TransferList} from ${JSON.stringify(path.join(root, "src/components/transfers/TransferList.tsx"))};
import {TESTNET} from ${JSON.stringify(path.join(root, "src/config/testnet.ts"))};
import ${JSON.stringify(path.join(root, "src/app/globals.css"))};
const pair=Keypair.fromRawEd25519Seed(new Uint8Array(globalThis.faultFixture.seed));
globalThis.faultTrace=[];globalThis.broadcasts=[];globalThis.faultStatus='ready';
rpc.Server.prototype.getNetwork=async()=>({passphrase:TESTNET.networkPassphrase});
rpc.Server.prototype.getAccount=async()=>new Account(pair.publicKey(),'0');
rpc.Server.prototype.sendTransaction=async tx=>{globalThis.broadcasts.push(tx.toXdr());globalThis.faultTrace.push('broadcast');throw new Error('Controlled uncertain RPC outcome');};
globalThis.readRecovery=()=>getTransferCheckpoint();
globalThis.inspectFaultState=()=>({owner:getOperationOwnership(),checkpoint:getTransferCheckpoint(),events:globalThis.faultTrace});
globalThis.beginIntent=async id=>{let lease;try{
 lease=await acquireOperationOwnership({id,account:pair.publicKey(),recipient:'0x'+'a'.repeat(40),destination:'sepolia',route:1,bridgeAmount:'10000000',stage:'conversion'});globalThis.faultTrace.push('owner:'+lease.id);globalThis.faultStatus='signing';
 const result=await submitClassicOperations(pair.publicKey(),[Operation.payment({destination:pair.publicKey(),asset:Asset.native(),amount:'1'})],original=>new Promise(resolve=>{globalThis.approveIntent=()=>{const tx=TransactionBuilder.fromXdr(original,TESTNET.networkPassphrase);tx.sign(pair);const signedTxXdr=verifyWalletSignature(original,tx.toXdr(),pair.publicKey());globalThis.faultTrace.push('signature:'+lease.id);resolve({signedTxXdr});};}),(phase,hash)=>{if(phase==='submitting'){saveCheckpoint({router:TESTNET.router,token:TESTNET.token,account:pair.publicKey(),recipient:'0x'+'a'.repeat(40),destination:'sepolia',route:1,bridgeAmount:'10000000',stage:'conversion',txHash:hash});globalThis.faultTrace.push('checkpoint:'+hash);}},undefined,{expectedAccount:pair.publicKey(),getCurrentAccount:()=>pair.publicKey(),isSuperseded:()=>getOperationOwnership()?.id!==lease.id});globalThis.faultStatus=result.status;
 }catch(error){globalThis.faultStatus=error.message;globalThis.faultTrace.push('rejected:'+id+':'+error.message);}finally{lease?.release();}};
createRoot(document.getElementById('root')).render(React.createElement('main',{style:{padding:'24px',maxWidth:'1080px',margin:'0 auto'}},React.createElement('h1',null,'Generated destination records'),React.createElement('p',null,'Actual production transfer list with generated local records. These values are fixtures.'),React.createElement(TransferList,{transfers:globalThis.faultFixture.records})));
`,
  );
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    resolve: {
      alias: [
        { find: /^react$/, replacement: path.join(root, "node_modules/react/index.js") },
        {
          find: /^react\/jsx-runtime$/,
          replacement: path.join(root, "node_modules/react/jsx-runtime.js"),
        },
        {
          find: /^@stellar\/stellar-sdk$/,
          replacement: path.join(root, "node_modules/@stellar/stellar-sdk/lib/esm/index.js"),
        },
      ],
    },
    plugins: [
      {
        name: "production-fault-source",
        enforce: "pre",
        resolveId(id) {
          if (id === "next/link") return "\0navigation-fixture";
        },
        load(id) {
          if (id === "\0navigation-fixture")
            return `import React from 'react';export default function Link({children,...props}){return React.createElement('a',props,children);}`;
        },
        transform(code, id) {
          if (id.endsWith(".tsx"))
            return {
              code: ts.transpileModule(code, {
                compilerOptions: {
                  jsx: ts.JsxEmit.ReactJSX,
                  module: ts.ModuleKind.ESNext,
                  target: ts.ScriptTarget.ES2022,
                },
              }).outputText,
              map: null,
            };
        },
      },
    ],
    build: {
      outDir: path.join(scratch, "dist"),
      emptyOutDir: true,
      lib: { entry, formats: ["iife"], name: "FaultFixture", fileName: "fixture" },
      minify: false,
    },
  });
  await writeFile(
    path.join(scratch, "dist/index.html"),
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.iife.js"></script></body></html>',
  );
  server = createServer(async (req, res) => {
    try {
      const name =
        req.url === "/fixture.iife.js"
          ? "fixture.iife.js"
          : req.url === "/fixture.css"
            ? "fixture.css"
            : "index.html";
      res.setHeader(
        "content-type",
        name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html",
      );
      res.end(await readFile(path.join(scratch, "dist", name)));
    } catch {
      res.statusCode = 500;
      res.end("Fixture unavailable");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await { chromium, firefox }[engine].launch(
    process.env.HYPERION_BROWSER_EXECUTABLE
      ? { executablePath: process.env.HYPERION_BROWSER_EXECUTABLE }
      : {},
  );
  const context = await browser.newContext();
  const records = [6, 7, null].map((decimals, i) => ({
    id: `fixture-${i}`,
    stage: "delivered",
    route: i === 0 ? 0 : 1,
    origin: {
      chain: "stellar-testnet",
      nonce: String(i + 1),
      sender: pair.publicKey(),
      token: "configured-source",
      symbol: "USDC",
      decimals: 7,
      grossAmount: "20000000",
      fee: "30000",
      netAmount: "19970000",
      block: "1",
      txHash: String(i + 1).repeat(64),
      observedAt: "2026-11-19T12:00:00.000Z",
    },
    destination: {
      chain: "sepolia",
      recipient: "0x" + "a".repeat(40),
      token: "0x" + String(i + 1).repeat(40),
      symbol: i === 1 ? "USDC (ITS)" : "USDC",
      decimals,
      amount: "1234567",
      delivered: true,
      txHash: "0x" + String(i + 4).repeat(64),
      block: "2",
      deliveredAt: "2026-11-19T12:01:00.000Z",
    },
    rail: null,
    claim: null,
  }));
  await context.addInitScript(
    (value) => {
      globalThis.faultFixture = value;
    },
    { seed: Array.from(pair.rawSecretKey()), records },
  );
  const first = await context.newPage(),
    second = await context.newPage(),
    errors = [];
  for (const page of [first, second]) page.on("pageerror", (error) => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await first.goto(origin);
  await second.goto(origin);
  await first.evaluate(() => {
    void globalThis.beginIntent("tab-a");
  });
  await expect.poll(() => first.evaluate(() => globalThis.faultStatus)).toBe("signing");
  await second.evaluate(() => globalThis.beginIntent("tab-b"));
  await expect
    .poll(() => second.evaluate(() => globalThis.faultStatus))
    .toContain("checkpoint tab-a");
  assert.equal(await second.evaluate(() => globalThis.broadcasts.length), 0);
  await first.evaluate(() => globalThis.approveIntent());
  await expect.poll(() => first.evaluate(() => globalThis.faultStatus)).toBe("pending");
  const checkpoint = await first.evaluate(() => globalThis.readRecovery());
  assert.match(checkpoint.txHash, /^[a-f0-9]{64}$/);
  assert.equal(await first.evaluate(() => globalThis.broadcasts.length), 1);
  trace.push(
    ...(await first.evaluate(() => globalThis.faultTrace)),
    ...(await second.evaluate(() => globalThis.faultTrace)),
  );
  await first.close();
  await second.reload();
  assert.deepEqual(await second.evaluate(() => globalThis.readRecovery()), checkpoint);
  await second.evaluate(() => globalThis.beginIntent("tab-c"));
  await expect
    .poll(() => second.evaluate(() => globalThis.faultStatus))
    .toContain(checkpoint.txHash);
  assert.equal(await second.evaluate(() => globalThis.broadcasts.length), 0);
  await expect(second.getByRole("feed", { name: "Transfers list" })).toContainText("1.234567");
  await expect(second.getByRole("feed")).toContainText("0.1234567");
  await expect(second.getByRole("feed")).toContainText("1234567 base units");
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await second.screenshot({
      path: path.join(evidence, "destination-desktop.png"),
      fullPage: true,
    });
  }
  await second.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await second.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  if (evidence)
    await second.screenshot({
      path: path.join(evidence, "destination-mobile.png"),
      fullPage: true,
    });
  assert.deepEqual(errors, []);
  const result = {
    engine,
    version: browser.version(),
    sources,
    checkpoint: checkpoint.txHash,
    events: trace,
    fixture:
      "Generated local keys/records, actual production coordination/checkpoint/signature/submission/list, controlled RPC transport and navigation boundary.",
  };
  if (evidence)
    await writeFile(
      path.join(evidence, "source-evidence.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
  console.log(JSON.stringify(result));
  await context.close();
} catch (error) {
  const tabs = await Promise.allSettled(
    (browser?.contexts().flatMap((context) => context.pages()) ?? []).map((page) =>
      page.evaluate(() => globalThis.inspectFaultState?.()),
    ),
  );
  console.error(JSON.stringify({ events: trace, sources, tabs }));
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await rm(scratch, { recursive: true, force: true });
}

import { describe, expect, it } from "vitest";
import { attributeBundles, clientChunk } from "./bundle-attribution.mjs";
import { sourceKey } from "./bundle-source-maps.mjs";

function fixture() {
  const graphModule = (ident, source, sync = [], async = []) => ({
    type: "module",
    ident: `${ident} [app-client]`,
    path: source,
    dependencies: {
      sync: sync.map((id) => `${id} [app-client]`),
      async: async.map((id) => `${id} [app-client]`),
      traced: [],
    },
  });
  const output = (filename, modules) => ({
    type: "output",
    route: "/",
    filename: `static/chunks/${filename}.js`,
    modules: modules.map((id) => `${id} [app-client]`),
    async_loaders: [],
    coverage: "exact",
  });
  return {
    records: [
      {
        type: "meta",
        schema_version: 1,
        module_index_hash: "fixture-fingerprint",
        route_count: 1,
        selected_routes: 1,
      },
      graphModule("app", "src/app/providers.tsx", ["sdk"]),
      graphModule("sdk", "src/wallets/stellar/sdk.ts", ["tx"], ["wallet"]),
      graphModule("tx", "node_modules/@stellar/stellar-sdk/lib/esm/index.js"),
      graphModule("wallet", "node_modules/@creit.tech/xbull-wallet-connect/lib/index.js"),
      {
        type: "route",
        route: "/",
        entries: [
          {
            module_ident: "app [app-client]",
            module_path: "src/app/providers.tsx",
            entry_kind: "client_bootstrap",
          },
        ],
        coverage: { entries: "exact", groups: "exact" },
      },
      output("app", ["app", "sdk"]),
      output("tx", ["tx"]),
      output("wallet", ["wallet"]),
      {
        type: "group",
        route: "/",
        id: 0,
        kind: "bootstrap",
        outputs: ["static/chunks/app.js", "static/chunks/tx.js"],
        trigger_module_ident: "app [app-client]",
        trigger_join: "joined",
      },
    ],
    firstLoads: [
      {
        route: "/",
        firstLoadChunkPaths: [".next/static/chunks/app.js", ".next/static/chunks/tx.js"],
        firstLoadUncompressedJsBytes: 1100,
      },
    ],
    sizes: {
      "static/chunks/app.js": {
        bytes: 100,
        sources: ["src/app/providers.tsx", "src/wallets/stellar/sdk.ts"],
      },
      "static/chunks/tx.js": {
        bytes: 1000,
        sources: ["node_modules/@stellar/stellar-sdk/lib/esm/index.js"],
      },
      "static/chunks/wallet.js": {
        bytes: 200,
        sources: ["node_modules/@creit.tech/xbull-wallet-connect/lib/index.js"],
      },
    },
  };
}

function check(value) {
  return attributeBundles(value.records, value.firstLoads, value.sizes);
}

describe("native production bundle attribution", () => {
  it("attributes mangled chunks by membership, preserving scoped package identity and async import chain", () => {
    const report = check(fixture());
    expect(report.errors).toEqual([]);
    expect(report.totals.map(({ bytes, maxBytes }) => [bytes, maxBytes])).toEqual([
      [200, 450000],
      [1000, 1200000],
    ]);
    const wallet = report.routes[0].categories[0].chunks[0];
    expect(wallet.initial).toBe(false);
    expect(wallet.imports[0].chain).toEqual([
      { path: "src/app/providers.tsx", via: "client-reference" },
      { path: "src/wallets/stellar/sdk.ts", via: "sync" },
      { path: "node_modules/@creit.tech/xbull-wallet-connect/lib/index.js", via: "async" },
    ]);
  });

  it("counts complete mixed chunks once per category, including runtime overhead", () => {
    const value = fixture();
    value.records
      .find((record) => record.filename === "static/chunks/wallet.js")
      .modules.push("tx [app-client]");
    value.sizes["static/chunks/wallet.js"].sources.push(
      "node_modules/@stellar/stellar-sdk/lib/esm/index.js",
    );
    expect(check(value).totals.map(({ bytes }) => bytes)).toEqual([200, 1200]);
  });

  it("rejects actual wallet bytes in the landing first-load manifest", () => {
    const value = fixture();
    value.firstLoads[0].firstLoadChunkPaths.push(".next/static/chunks/wallet.js");
    value.firstLoads[0].firstLoadUncompressedJsBytes += 200;
    expect(check(value).errors).toContain(
      "Wallet adapter loaded on landing: static/chunks/wallet.js",
    );
  });

  it("keeps budgets unchanged and identifies offending chunks and importer chains", () => {
    const value = fixture();
    value.sizes["static/chunks/wallet.js"].bytes = 450001;
    const report = check(value);
    expect(report.errors).toContain("wallet adapters client budget exceeded: 450001 > 450000");
    expect(report.routes[0].categories[0].chunks[0].imports[0].chain[0].path).toBe(
      "src/app/providers.tsx",
    );
  });

  it.each(["unsupported", "not_a_chunk"])(
    "fails closed on %s client output membership",
    (coverage) => {
      const value = fixture();
      value.records.find((record) => record.filename === "static/chunks/wallet.js").coverage =
        coverage;
      expect(() => check(value)).toThrow("missing client membership");
    },
  );

  it("fails closed when a budget silently loses all module attribution", () => {
    const value = fixture();
    value.records.find((record) => record.ident === "wallet [app-client]").path =
      "node_modules/not-the-wallet/index.js";
    value.sizes["static/chunks/wallet.js"].sources = ["node_modules/not-the-wallet/index.js"];
    expect(() => check(value)).toThrow("no wallet adapters attribution");
  });

  it("fails closed on missing edges and disconnected importer chains", () => {
    const value = fixture();
    value.records.find((record) => record.ident === "sdk [app-client]").dependencies.async = [];
    expect(() => check(value)).toThrow("emitted chunk has no route import chain");
    delete value.records.find((record) => record.ident === "sdk [app-client]").dependencies.async;
    expect(() => check(value)).toThrow("missing async edges");
  });

  it("fails closed on unjoined identities", () => {
    const value = fixture();
    value.records
      .find((record) => record.ident === "sdk [app-client]")
      .dependencies.sync.push("unknown");
    expect(() => check(value)).toThrow("unjoined dependency");
  });

  it("fails closed on truncated routes and missing route coverage", () => {
    const value = fixture();
    value.records[0].route_count = 2;
    value.records[0].selected_routes = 2;
    expect(() => check(value)).toThrow("truncated graph");
    value.records[0].route_count = 1;
    value.records[0].selected_routes = 1;
    value.records.find((record) => record.type === "route").coverage.entries = "unknown";
    expect(() => check(value)).toThrow("missing route coverage");
  });

  it("fails closed when actual output bytes differ from route first-load bytes", () => {
    const value = fixture();
    value.sizes["static/chunks/tx.js"].bytes += 1;
    expect(() => check(value)).toThrow("first-load bytes disagree");
  });

  it("requires every initial output to join the native graph", () => {
    const value = fixture();
    value.firstLoads[0].firstLoadChunkPaths.push(".next/static/chunks/missing.js");
    expect(() => check(value)).toThrow("initial chunk absent from output");
  });

  it("rejects unsafe chunk paths", () => {
    expect(() => clientChunk("static/chunks/../secret.js")).toThrow("output path traversal");
    expect(clientChunk("server/chunks/tx.js")).toBe(null);
  });

  it("does not trust independently materialized analyzer chunk filenames", () => {
    const value = fixture();
    for (const record of value.records)
      if (record.type === "output")
        record.filename = record.filename.replace("chunks/", "chunks/analyzer-");
    expect(check(value).totals.map(({ bytes }) => bytes)).toEqual([200, 1000]);
  });

  it("joins flattened original source-map paths through exact upstream maps", () => {
    const value = fixture();
    value.sizes["static/chunks/wallet.js"].sources = ["node_modules/@creit.tech/src/index.ts"];
    expect(() => check(value)).toThrow("unjoined emitted source");
    const aliases = {
      "node_modules/@creit.tech/xbull-wallet-connect/lib/index.js": [
        "node_modules/@creit.tech/src/index.ts",
      ],
    };
    expect(
      attributeBundles(value.records, value.firstLoads, value.sizes, aliases).totals[0].bytes,
    ).toBe(200);
  });

  it("fails closed on a missing emitted source map and empty unjoined map", () => {
    const value = fixture();
    delete value.sizes["static/chunks/wallet.js"].sources;
    expect(() => check(value)).toThrow("missing actual client bytes or source map");
    value.sizes["static/chunks/wallet.js"].sources = [];
    value.records.find((record) => record.filename === "static/chunks/wallet.js").filename =
      "static/chunks/other.js";
    expect(() => check(value)).toThrow("empty source map has no exact native join");
  });

  it("requires native route entries and client references to join", () => {
    const value = fixture();
    const entry = value.records.find((record) => record.type === "route").entries[0];
    entry.client_references = [{ module_ident: "missing", module_path: "src/app/missing.tsx" }];
    expect(() => check(value)).toThrow("unjoined client reference");
    delete entry.client_references;
    entry.module_path = "src/app/missing.tsx";
    expect(() => check(value)).toThrow("unjoined route entry");
  });

  it("detects eager unused wallet modules co-located in a shared landing chunk", () => {
    const value = fixture();
    value.records.find((record) => record.ident === "sdk [app-client]").dependencies.async = [];
    delete value.sizes["static/chunks/wallet.js"];
    value.sizes["static/chunks/app.js"].sources.push(
      "node_modules/@creit.tech/xbull-wallet-connect/lib/index.js",
    );
    const report = check(value);
    expect(report.errors).toContain("Wallet adapter loaded on landing: static/chunks/app.js");
    expect(report.routes[0].categories[0].chunks[0].imports[0].chain.at(-1).via).toBe("same-chunk");
  });

  it("normalizes generated CSS and JSON source identities without package-name guesses", () => {
    expect(
      sourceKey("turbopack:///[project]/src/app/page.module.css [app-client] (css module)"),
    ).toBe("[project]/src/app/page.module.css");
    expect(
      sourceKey(
        "turbopack:///[project]/src/config/deployment.json.[json].cjs/turbopack:///src/config/deployment.json",
      ),
    ).toBe("[project]/src/config/deployment.json.[json].cjs");
  });
});

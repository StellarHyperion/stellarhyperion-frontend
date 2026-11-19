import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.join(process.cwd(), ".next", "static", "chunks");
const budgets = [
  {
    name: "wallet adapters",
    markers: [
      "@stellar/freighter-api",
      "@albedo-link/intent",
      "xbull-wallet-connect",
      "signer-extension-api",
    ],
    maxBytes: 450_000,
  },
  {
    name: "transaction code",
    markers: ["@stellar/stellar-sdk", "@hyperion/protocol"],
    maxBytes: 1_200_000,
  },
];

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesIn(file)));
    else if (entry.name.endsWith(".js")) files.push(file);
  }
  return files;
}

let files;
try {
  files = await filesIn(root);
} catch {
  throw new Error("Build output is missing. Run next build before checking client budgets.");
}

const chunks = await Promise.all(
  files.map(async (file) => ({
    file: path.relative(root, file),
    text: await readFile(file, "utf8"),
    bytes: (await stat(file)).size,
  })),
);
for (const budget of budgets) {
  const matching = chunks.filter(({ text }) =>
    budget.markers.some((marker) => text.includes(marker)),
  );
  const totalBytes = matching.reduce((sum, chunk) => sum + chunk.bytes, 0);
  if (totalBytes > budget.maxBytes) {
    const details = matching.map(({ file, bytes }) => `${file} (${bytes} bytes)`).join(", ");
    throw new Error(
      `${budget.name} client budget exceeded: ${totalBytes} > ${budget.maxBytes}. ${details}`,
    );
  }
  console.log(
    `${budget.name}: ${totalBytes}/${budget.maxBytes} bytes across ${matching.length} chunk(s)`,
  );
}

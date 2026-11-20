import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Atomic replacement keeps the preceding public hashes recoverable after interruption. */
export function saveProof(file: string, proof: object, beforeRename?: () => void): void {
  if (existsSync(file)) {
    if (!lstatSync(file).isFile()) throw new Error("The saved proof must be a regular file.");
    const previous: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!previous || typeof previous !== "object" || Array.isArray(previous))
      throw new Error("The saved proof is invalid; retain it for manual recovery.");
    for (const key of ["sourceHash", "conversionHash", "destinationHash"] as const) {
      const value = (previous as Record<string, unknown>)[key];
      if (value !== undefined && (proof as Record<string, unknown>)[key] !== value)
        throw new Error("Never overwrite an unresolved public transaction hash.");
    }
  }
  const temp = join(dirname(file), ".hyperion-proof-" + randomUUID());
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(proof, null, 2) + "\n");
    fsyncSync(fd);
    beforeRename?.();
    renameSync(temp, file);
  } finally {
    closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}

/** One live runner owns each proof; a competing process cannot sign from the same record. */
export function lockProof(file: string): () => void {
  const lock = file + ".lock";
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch {
    throw new Error(
      "This proof has another live runner or an interrupted lock; inspect it before signing.",
    );
  }
  writeFileSync(fd, String(process.pid) + "\n");
  return () => {
    closeSync(fd);
    unlinkSync(lock);
  };
}

export function defaultProofFile(): string {
  const directory = join(homedir(), ".hyperion-testnet-proofs");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("The live-transfer proof directory must be private and owned by this user.");
  return join(directory, "its-transfer.json");
}

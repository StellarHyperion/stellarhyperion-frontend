/**
 * Reusable wallet fixture builders for adapter compatibility tests.
 *
 * All keys are generated with Keypair.random(). No literal secret seeds appear
 * anywhere in this file. The helpers return plain XDR strings that tests can
 * feed directly into verifyWalletSignature or walletSign mocks.
 *
 * SDK behaviour confirmed by running throwaway node probes:
 *   - V0 envelopes ARE supported. xdr.TransactionEnvelope.envelopeTypeTxV0
 *     constructs a valid envelope that parses as Transaction (not FeeBumpTransaction),
 *     and its hash is byte-for-byte identical to the hash of the equivalent V1
 *     envelope. verifyWalletSignature(v1OriginalXdr, signedV0Xdr, pubkey) succeeds.
 *     This was proven by a throwaway node probe that printed both hashes and
 *     confirmed they were equal; the probe was deleted afterwards.
 *   - TransactionBuilder.fromXdr on a fee-bump XDR returns FeeBumpTransaction.
 *   - Garbage, empty, hex strings, and truncated XDR all throw XDR parse errors
 *     with messages containing "TransactionEnvelope.type: unknown enum value"
 *     or "incomplete XDR data".
 */
import type { Transaction } from "@stellar/stellar-sdk";
import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { TESTNET } from "../../src/config/testnet";

/** Fixed deterministic time bounds: epoch 0 through a far future timestamp. */
export const DEFAULT_TIME_BOUNDS = { minTime: "0", maxTime: "1893456000" } as const;

/** Options for building a payment transaction fixture. */
export interface PaymentFixtureOptions {
  /** XLM amount as a string, e.g. "10". Defaults to "10". */
  amount?: string;
  /** Asset to use. Defaults to native (XLM). */
  asset?: Asset;
  /** Text memo to attach. Omit for no memo. */
  memo?: string;
  /** Base fee in stroops as a string. Defaults to "100". */
  fee?: string;
  /** Source account keypair. Defaults to a fresh random keypair. */
  source?: Keypair;
  /** Destination public key. Defaults to a fresh random keypair. */
  destination?: string;
  /** Network passphrase. Defaults to Testnet. */
  networkPassphrase?: string;
  /** Time bounds for the transaction. Defaults to fixed minTime 0 and maxTime 1893456000. */
  timebounds?: { minTime: string; maxTime: string };
}

/** A fully populated fixture with both unsigned and signed XDR. */
export interface PaymentFixture {
  /** The keypair that owns the source account. */
  source: Keypair;
  /** Fixed destination used by this fixture. */
  destination: string;
  /** Unsigned XDR (what the app sends to the wallet). */
  unsignedXdr: string;
  /** XDR signed by source (what a correct wallet returns). */
  signedXdr: string;
  /** Amount used in the payment operation. */
  amount: string;
  /** Asset used in the payment operation. */
  asset: Asset;
  /** Fee used (string stroops). */
  fee: string;
  /** Text memo used, if any. */
  memo?: string;
  /** Fixed time bounds used. */
  timebounds: { minTime: string; maxTime: string };
  /** Network passphrase used. */
  networkPassphrase: string;
}

/**
 * Build a payment transaction fixture with configurable parameters.
 * Uses fixed deterministic time bounds with no dependency on Date.now.
 * All keys are freshly generated unless provided.
 */
export function buildPaymentFixture(options: PaymentFixtureOptions = {}): PaymentFixture {
  const {
    amount = "10",
    asset = Asset.native(),
    memo,
    fee = "100",
    source = Keypair.random(),
    destination = Keypair.random().publicKey(),
    networkPassphrase = TESTNET.networkPassphrase,
    timebounds = DEFAULT_TIME_BOUNDS,
  } = options;

  const builder = new TransactionBuilder(new Account(source.publicKey(), "0"), {
    fee,
    networkPassphrase,
    timebounds,
  }).addOperation(Operation.payment({ destination, asset, amount }));

  if (memo !== undefined) builder.addMemo(Memo.text(memo));

  const tx = builder.build();
  const unsignedXdr = tx.toXdr();
  tx.sign(source);
  return {
    source,
    destination,
    unsignedXdr,
    signedXdr: tx.toXdr(),
    amount,
    asset,
    fee,
    ...(memo !== undefined ? { memo } : {}),
    timebounds,
    networkPassphrase,
  };
}

/**
 * Rebuild an identical transaction with the exact same parameters and sign it.
 * Used as a control in tests to confirm that re-running the builder with identical
 * parameters produces accepted, cryptographically identical signed XDR.
 */
export function identicalRebuildSignedXdr(fixture: PaymentFixture): string {
  const rebuilt = buildPaymentFixture({
    amount: fixture.amount,
    asset: fixture.asset,
    ...(fixture.memo !== undefined ? { memo: fixture.memo } : {}),
    fee: fixture.fee,
    source: fixture.source,
    destination: fixture.destination,
    networkPassphrase: fixture.networkPassphrase,
    timebounds: fixture.timebounds,
  });
  return rebuilt.signedXdr;
}

/**
 * Return signed XDR produced by signing the original envelope with a different
 * keypair, so that signature verification fails the "connected account" check.
 */
export function signedByOtherKey(
  unsignedXdr: string,
  networkPassphrase = TESTNET.networkPassphrase,
): { xdr: string; signer: Keypair } {
  const other = Keypair.random();
  const tx = TransactionBuilder.fromXdr(unsignedXdr, networkPassphrase) as Transaction;
  tx.sign(other);
  return { xdr: tx.toXdr(), signer: other };
}

/**
 * Return signed XDR that has extra signatures in addition to the correct one.
 * The correct key is included, so the verification should still pass.
 */
export function signedWithExtraSignatures(
  unsignedXdr: string,
  correctSigner: Keypair,
  networkPassphrase = TESTNET.networkPassphrase,
): string {
  const tx = TransactionBuilder.fromXdr(unsignedXdr, networkPassphrase) as Transaction;
  tx.sign(Keypair.random());
  tx.sign(correctSigner);
  tx.sign(Keypair.random());
  return tx.toXdr();
}

/**
 * Return signed XDR where the envelope was signed over the PUBLIC network
 * passphrase instead of Testnet. The transaction body is the same, but the
 * hash differs, so the signature check must reject it.
 */
export function signedOverPublicNetwork(
  unsignedXdr: string,
  signer: Keypair,
): { xdr: string; signedHash: Buffer } {
  const tx = TransactionBuilder.fromXdr(unsignedXdr, Networks.PUBLIC) as Transaction;
  tx.sign(signer);
  const hash = Buffer.from(tx.hash());
  return { xdr: tx.toXdr(), signedHash: hash };
}

/**
 * Wrap a signed transaction in a fee-bump envelope.
 * Returns the fee-bump XDR. The inner transaction must already be signed.
 */
export function feeBumpWrapped(
  signedInnerXdr: string,
  networkPassphrase = TESTNET.networkPassphrase,
): string {
  const inner = TransactionBuilder.fromXdr(signedInnerXdr, networkPassphrase) as Transaction;
  const feeSource = Keypair.random();
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    feeSource,
    "200",
    inner,
    networkPassphrase,
  );
  feeBump.sign(feeSource);
  return feeBump.toXdr();
}

/** Return the unsigned XDR as-is (wallet echoed back without signing). */
export function unsignedEcho(unsignedXdr: string): string {
  return unsignedXdr;
}

/**
 * Return a string that is not valid base64 XDR. Used to test garbage-input
 * handling. The pattern is intentionally not seed-shaped.
 */
export function garbageXdr(): string {
  return "not-valid-xdr-data-at-all";
}

/** Return an empty string, which the XDR parser rejects as incomplete. */
export function emptyXdr(): string {
  return "";
}

/**
 * Return a truncated version of a valid XDR (first 20 chars), which the XDR
 * parser rejects as incomplete.
 */
export function truncatedXdr(validXdr: string): string {
  return validXdr.slice(0, 20);
}

/**
 * Build a fixture where only the amount differs from the original (off by one stroop).
 * Exactly one field is altered. Hash will differ so the "changed the transaction" check fires.
 * Returns signed XDR signed by the same source key.
 */
export function alteredAmountXdr(fixture: PaymentFixture): string {
  const altered = buildPaymentFixture({
    amount: "10.0000001",
    asset: fixture.asset,
    ...(fixture.memo !== undefined ? { memo: fixture.memo } : {}),
    fee: fixture.fee,
    source: fixture.source,
    destination: fixture.destination,
    timebounds: fixture.timebounds,
    networkPassphrase: fixture.networkPassphrase,
  });
  return altered.signedXdr;
}

/**
 * Build a fixture where only the asset issuer differs.
 * Exactly one field is altered. Hash will differ so the "changed the transaction" check fires.
 * Returns signed XDR signed by the same source key.
 */
export function alteredIssuerXdr(fixture: PaymentFixture): string {
  const differentIssuer = Keypair.random().publicKey();
  const altered = buildPaymentFixture({
    amount: fixture.amount,
    asset: new Asset("USDC", differentIssuer),
    ...(fixture.memo !== undefined ? { memo: fixture.memo } : {}),
    fee: fixture.fee,
    source: fixture.source,
    destination: fixture.destination,
    timebounds: fixture.timebounds,
    networkPassphrase: fixture.networkPassphrase,
  });
  return altered.signedXdr;
}

/**
 * Build a fixture where only the text memo differs.
 * Exactly one field is altered. Hash will differ so the "changed the transaction" check fires.
 * Returns signed XDR signed by the same source key.
 */
export function alteredMemoXdr(fixture: PaymentFixture): string {
  const altered = buildPaymentFixture({
    amount: fixture.amount,
    asset: fixture.asset,
    memo: fixture.memo === undefined ? "altered-memo" : `${fixture.memo}-altered`,
    fee: fixture.fee,
    source: fixture.source,
    destination: fixture.destination,
    timebounds: fixture.timebounds,
    networkPassphrase: fixture.networkPassphrase,
  });
  return altered.signedXdr;
}

/**
 * Build a fixture where only the fee differs.
 * Exactly one field is altered. Hash will differ so the "changed the transaction" check fires.
 * Returns signed XDR signed by the same source key.
 */
export function alteredFeeXdr(fixture: PaymentFixture): string {
  const altered = buildPaymentFixture({
    amount: fixture.amount,
    asset: fixture.asset,
    ...(fixture.memo !== undefined ? { memo: fixture.memo } : {}),
    fee: "9999",
    source: fixture.source,
    destination: fixture.destination,
    timebounds: fixture.timebounds,
    networkPassphrase: fixture.networkPassphrase,
  });
  return altered.signedXdr;
}

/**
 * Build a fixture where only the destination differs.
 * Exactly one field is altered. Hash will differ so the "changed the transaction" check fires.
 * Returns signed XDR signed by the same source key.
 */
export function alteredDestinationXdr(fixture: PaymentFixture): string {
  const differentDest = Keypair.random().publicKey();
  const altered = buildPaymentFixture({
    amount: fixture.amount,
    asset: fixture.asset,
    ...(fixture.memo !== undefined ? { memo: fixture.memo } : {}),
    fee: fixture.fee,
    source: fixture.source,
    destination: differentDest,
    timebounds: fixture.timebounds,
    networkPassphrase: fixture.networkPassphrase,
  });
  return altered.signedXdr;
}

/**
 * Build the V0-envelope form of the fixture transaction, signed with the source key.
 *
 * The V0 envelope is constructed from the same fields as the fixture's V1 envelope
 * (same fee, seqNum, time bounds, memo, and operations), so it carries exactly the
 * same transaction hash as the original. This was confirmed by a throwaway probe:
 * both hashes printed as the same 64-character hex string and verifyWalletSignature
 * accepted the signed V0 XDR when given the V1 original. The fixed time bounds from
 * the fixture are preserved because they are read directly from the already-built
 * V1 envelope rather than being re-defaulted.
 */
export function buildV0SignedXdr(fixture: PaymentFixture): string {
  const v1Envelope = xdr.TransactionEnvelope.fromXdr(fixture.unsignedXdr, "base64");
  if (v1Envelope.type !== "envelopeTypeTx") {
    throw new Error("Expected envelopeTypeTx");
  }
  const v1Tx = v1Envelope.v1.tx;
  const rawEd25519 = fixture.source.rawPublicKey();
  const timeBounds = v1Tx.cond.type === "precondTime" ? v1Tx.cond.timeBounds : null;

  const txV0 = new xdr.TransactionV0({
    sourceAccountEd25519: rawEd25519,
    fee: v1Tx.fee,
    seqNum: v1Tx.seqNum,
    timeBounds,
    memo: v1Tx.memo,
    operations: v1Tx.operations,
    ext: xdr.TransactionV0Ext.v0(),
  });

  const v0Envelope = xdr.TransactionEnvelope.envelopeTypeTxV0(
    new xdr.TransactionV0Envelope({
      tx: txV0,
      signatures: [],
    }),
  );

  const parsed = TransactionBuilder.fromXdr(v0Envelope.toXdr("base64"), fixture.networkPassphrase);
  parsed.sign(fixture.source);
  return parsed.toXdr();
}

/**
 * Build a V0 envelope carrying an altered amount (off by one stroop).
 * Exactly one field differs from the original fixture: the amount is "10.0000001"
 * instead of "10". All other fields (asset, memo, fee, source, destination, time
 * bounds, network passphrase) are taken unchanged from the fixture so that any
 * rejection is caused solely by the amount change.
 * The transaction hash will differ from the original V1 envelope, so
 * verifyWalletSignature must reject it with "changed the transaction".
 */
export function alteredAmountV0Xdr(fixture: PaymentFixture): string {
  const altered = buildPaymentFixture({
    amount: "10.0000001",
    asset: fixture.asset,
    ...(fixture.memo !== undefined ? { memo: fixture.memo } : {}),
    fee: fixture.fee,
    source: fixture.source,
    destination: fixture.destination,
    timebounds: fixture.timebounds,
    networkPassphrase: fixture.networkPassphrase,
  });
  return buildV0SignedXdr(altered);
}

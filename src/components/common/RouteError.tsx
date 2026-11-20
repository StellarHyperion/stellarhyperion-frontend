"use client";

import Link from "next/link";
import { type ReactElement } from "react";
import { Column } from "../chrome";
import { useStellarWallet } from "../../wallets/stellar/context";
import { useTransferCheckpoint } from "../../contracts/checkpoint";
import { invalidateCapabilityDiscovery } from "../../contracts/stellar";
import styles from "./RouteError.module.css";

export function RouteError({
  reset,
  flow,
  backHref,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
  readonly flow: string;
  readonly backHref: "/" | "/transfers";
}): ReactElement {
  const wallet = useStellarWallet();
  const checkpoint = useTransferCheckpoint();
  return (
    <Column>
      <section className={styles.recovery} aria-label="View recovery">
        <h1 className="display">This {flow} needs a refresh</h1>
        <p role="alert">This view could not render. Try again to reload its read-only data.</p>
        <dl className={styles.context}>
          <div>
            <dt>Network</dt>
            <dd>Stellar Testnet</dd>
          </div>
          <div>
            <dt>Connected account</dt>
            <dd>{wallet.address ?? "No Stellar account is connected."}</dd>
          </div>
          <div>
            <dt>Saved source transaction</dt>
            <dd>
              {checkpoint ? (
                <code>{checkpoint.txHash}</code>
              ) : (
                "No transfer recovery record is available in this browser."
              )}
            </dd>
          </div>
        </dl>
        {checkpoint && (
          <p>
            The saved hash does not establish broadcast or confirmation. Return to the bridge to
            check source status before approving another transfer.
          </p>
        )}
        <div className={styles.actions}>
          <button
            type="button"
            onClick={() => {
              invalidateCapabilityDiscovery();
              reset();
            }}
          >
            Try again
          </button>{" "}
          <Link href={backHref}>{backHref === "/" ? "Return to bridge" : "Open activity"}</Link>
        </div>
      </section>
    </Column>
  );
}

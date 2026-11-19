"use client";

import Link from "next/link";
import { useEffect, type ReactElement } from "react";
import { Column } from "../chrome";

export function RouteError({
  error,
  reset,
  flow,
  backHref,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
  readonly flow: string;
  readonly backHref: "/" | "/transfers";
}): ReactElement {
  useEffect(() => {
    // Keep diagnostics bounded and useful without exposing provider responses or stack traces.
    console.error(`Hyperion ${flow} rendering error`, error.digest ?? "undisclosed");
  }, [error, flow]);
  return (
    <Column>
      <p className="mono">Stellar Testnet</p>
      <h1 className="display">This {flow} needs a refresh</h1>
      <p role="alert">
        Hyperion kept your wallet and saved transfer context. Refresh this view to try again.
      </p>
      <div>
        <button type="button" onClick={reset}>
          Try again
        </button>{" "}
        <Link href={backHref}>{backHref === "/" ? "Return to bridge" : "Open activity"}</Link>
      </div>
    </Column>
  );
}

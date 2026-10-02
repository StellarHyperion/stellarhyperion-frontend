/**
 * One leg of the route, origin or destination.
 *
 * Two of these bracket the switchyard, and the coloured rule down the left of each is the thing
 * tying the layout to the product. Copper beside the leg you control, instrument blue beside the
 * leg you wait on, and the yard in between is where one becomes the other. Scrolling the page is
 * following the money.
 *
 * The facts are a hairline grid rather than a set of cards. Depth in this build comes from one
 * pixel rules and a background step, and there is not a single box shadow anywhere in it.
 */
import type { ReactElement } from "react";

import styles from "./Leg.module.css";

export interface Fact {
  readonly label: string;
  readonly value: string;
}

export interface LegProps {
  readonly side: "origin" | "destination";
  readonly chain: string;
  /** What this leg is, in a few words. Mono, beside the chain name. */
  readonly meta: string;
  readonly summary: string;
  readonly facts: readonly Fact[];
}

export function RouteLeg({ side, chain, meta, summary, facts }: LegProps): ReactElement {
  const origin = side === "origin";

  return (
    <section
      className={styles.leg}
      aria-label={`${origin ? "Origin" : "Destination"} leg, ${chain}`}
    >
      <div className={styles.spine}>
        <span
          className={`${styles.rail} ${origin ? styles.railOrigin : styles.railDestination}`}
          aria-hidden="true"
        />
        <div className={styles.body}>
          <div className={styles.chainLine}>
            <h2 className={styles.chainName}>{chain}</h2>
            <p className={`mono ${styles.chainMeta}`}>{meta}</p>
          </div>
          <p className="prose">{summary}</p>
          <dl className={styles.facts}>
            {facts.map((fact) => (
              <div className={styles.fact} key={fact.label}>
                <dt className={`mono ${styles.factLabel}`}>{fact.label}</dt>
                <dd className={`mono ${styles.factValue}`}>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}

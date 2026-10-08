/**
 * The switchyard: four candidate rails, drawn, with the loser's reason attached to it.
 *
 * This is the one place in the build spending its budget on a picture, and it earns it by making
 * the architecture's central claim inspectable. Hyperion's thesis is that it never invents a
 * cross-chain trust mechanism; it prices rails that are already live and audited, and throws a
 * switch. A page can assert that in a paragraph. A yard that draws all four tracks, lights the one
 * that won, and writes "waits 13m on attestation" next to the one that lost, lets somebody check
 * it.
 *
 * Purely presentational. It never prices anything, never formats an amount and never decides a
 * winner. Every one of those arrives in props, computed by the router or by the protocol package's
 * local mirror of it, which is what stops the drawing from telling a more flattering story than
 * the chain would.
 *
 * Two deliberate choices about who this is for. The drawing is `aria-hidden` and the table under
 * it is not, because a diagram described through alt text is a diagram nobody can read; the table
 * carries the same facts in the same order and is the primary representation for a screen reader.
 * And below forty eight rem the drawing is removed rather than squeezed, because four tracks in a
 * phone's width is four parallel lines nobody can tell apart.
 */
import { useState, type ReactElement } from "react";
import type { RouteKind } from "@hyperion/protocol";

import styles from "./Switchyard.module.css";
import {
  CENTRE_Y,
  DESTINATION_X,
  ORIGIN_X,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  pathLengthEstimate,
  trackPath,
} from "./geometry";
import { Track as TrackComponent } from "./Track";
import type { Leg, Track, YardState } from "./types";

export interface SwitchyardProps {
  readonly origin: Leg;
  readonly destination: Leg;
  /** In the rail order the router returns them, so the yard never reshuffles between renders. */
  readonly tracks: readonly Track[];
  readonly state: YardState;
  /**
   * Changes whenever a new quote resolves.
   *
   * React keys the drawn track on this, which remounts the path and restarts the draw-in. Without
   * it a second quote for a different amount would swap the numbers while the line sat there
   * already drawn, and the one piece of motion in this component is the only thing saying that
   * something just changed.
   */
  readonly resolutionId?: string | number;
}

const DRAW_LENGTH = pathLengthEstimate();

/** What the heading says about where the yard is up to. Mono, lowercase, no exclamation. */
const STATE_NOTE: Record<YardState, string> = {
  idle: "waiting for an amount",
  pricing: "pricing four rails",
  resolved: "one rail won",
  blocked: "no rail can carry this",
};

export function Switchyard({
  origin,
  destination,
  tracks,
  state,
  resolutionId = 0,
}: SwitchyardProps): ReactElement {
  const count = tracks.length;
  const [inspectedRoute, setInspectedRoute] = useState<RouteKind | null>(null);

  return (
    <section className={styles.yard} aria-labelledby="switchyard-heading">
      <div className={styles.inner}>
        <div className={styles.heading}>
          <h2 className="heading" id="switchyard-heading">
            The switchyard
          </h2>
          <p className={`mono ${styles.state}`}>{STATE_NOTE[state]}</p>
        </div>

        <svg
          className={styles.canvas}
          viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`}
          role="region"
          aria-label="Switchyard rail tracks"
        >
          <defs>
            {/*
             * Copper at the origin, instrument blue at the destination. The gradient is not
             * decoration: it is the two halves of the transfer, the leg you control and the leg
             * you wait on, and the crossing point is where custody stops being yours.
             */}
            <linearGradient
              id="hyperion-yard-leg"
              x1={ORIGIN_X}
              y1={CENTRE_Y}
              x2={DESTINATION_X}
              y2={CENTRE_Y}
              gradientUnits="userSpaceOnUse"
            >
              <stop offset="0" stopColor="var(--leg-origin)" />
              <stop offset="1" stopColor="var(--leg-destination)" />
            </linearGradient>
          </defs>

          {tracks.map((track, index) => {
            const path = trackPath(index, count);
            const isInspected = inspectedRoute === track.route;
            return (
              <TrackComponent
                key={`track-${String(track.route)}`}
                track={track}
                path={path}
                state={state}
                resolutionId={resolutionId}
                isInspected={isInspected}
                onInspect={() => {
                  setInspectedRoute(track.route);
                }}
                onDismiss={() => {
                  setInspectedRoute((prev) => (prev === track.route ? null : prev));
                }}
                drawLength={DRAW_LENGTH}
              />
            );
          })}

          <Node x={ORIGIN_X} leg={origin} side="origin" />
          <Node x={DESTINATION_X} leg={destination} side="destination" />
        </svg>

        {/*
         * The same four rails as a table, and the representation that is actually read out.
         * Ordered exactly as the drawing orders them, so somebody reading both does not have to
         * reconcile two sequences.
         */}
        <div className={styles.legend}>
          {tracks.map((track) => {
            const chosen = track.chosen && state === "resolved";
            const isInspected = inspectedRoute === track.route;
            const inspection = track.inspection;
            return (
              <div
                key={`row-${String(track.route)}`}
                tabIndex={0}
                role="button"
                aria-label={`Inspect ${track.label} rail details`}
                aria-expanded={isInspected}
                onClick={() => {
                  setInspectedRoute((prev) => (prev === track.route ? null : track.route));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setInspectedRoute((prev) => (prev === track.route ? null : track.route));
                  } else if (e.key === "Escape") {
                    setInspectedRoute(null);
                  }
                }}
                onFocus={() => {
                  setInspectedRoute(track.route);
                }}
                onBlur={() => {
                  setInspectedRoute((prev) => (prev === track.route ? null : prev));
                }}
                className={`${styles.legendRow} ${styles.legendInteractive} ${chosen ? styles.legendRowChosen : ""} ${isInspected ? styles.legendRowInspected : ""}`}
              >
                <div>
                  <span className={`${styles.legendRail} ${chosen ? styles.legendRailChosen : ""}`}>
                    {track.label}
                    {chosen ? " (taken)" : ""}
                  </span>
                </div>
                <div className={styles.legendLanding}>{track.landing ?? "no quote"}</div>
                <div>{track.verdict?.note ?? describeAvailable(track)}</div>
                {isInspected && inspection && (
                  <div className={styles.legendDetail} role="region">
                    <span className={styles.legendDetailItem}>
                      <span className={styles.legendDetailLabel}>quoted fee: </span>
                      {inspection.quotedFee}
                    </span>
                    <span className={styles.legendDetailItem}>
                      <span className={styles.legendDetailLabel}>headroom: </span>
                      {inspection.headroom}
                    </span>
                    <span className={styles.legendDetailItem}>
                      <span className={styles.legendDetailLabel}>code: </span>
                      <span className={styles.legendDetailCode}>
                        {inspection.disqualificationCode}
                      </span>
                    </span>
                    <span className={styles.legendDetailItem}>
                      <span className={styles.legendDetailLabel}>reason: </span>
                      {inspection.disqualificationReason}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/**
 * A rail that is available, described by what it costs rather than by the absence of a problem.
 *
 * "Available" on its own tells somebody nothing they can use. What they want to know is whether
 * they are going to be waiting and whether they are getting the real asset.
 */
function describeAvailable(track: Track): string {
  const parts: string[] = [];
  parts.push(track.canonical ? "canonical asset" : "pooled or wrapped");
  parts.push(track.waitsOnAttestation ? "waits on an attestation" : "no attestation wait");
  return parts.join(", ");
}

interface NodeProps {
  readonly x: number;
  readonly leg: Leg;
  readonly side: "origin" | "destination";
}

function Node({ x, leg, side }: NodeProps): ReactElement {
  const origin = side === "origin";
  // Names sit outside the span rather than above the node, so they never collide with a track.
  const anchor = origin ? "end" : "start";
  const textX = origin ? x - 18 : x + 18;

  return (
    <g>
      <circle
        className={`${styles.nodeRing} ${origin ? styles.nodeRingOrigin : styles.nodeRingDestination}`}
        cx={x}
        cy={CENTRE_Y}
        r={11}
      />
      <circle
        className={`${styles.nodeCore} ${origin ? styles.nodeCoreOrigin : styles.nodeCoreDestination}`}
        cx={x}
        cy={CENTRE_Y}
        r={4}
      />
      <text className={styles.nodeName} x={textX} y={CENTRE_Y - 4} textAnchor={anchor}>
        {leg.name}
      </text>
      <text className={styles.nodeDetail} x={textX} y={CENTRE_Y + 14} textAnchor={anchor}>
        {leg.detail}
      </text>
    </g>
  );
}

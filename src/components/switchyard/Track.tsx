"use client";

import type { KeyboardEvent, ReactElement } from "react";
import type { TrackPath } from "./geometry";
import styles from "./Switchyard.module.css";
import type { Track as TrackType, TrackInspection, YardState } from "./types";

export interface TrackProps {
  readonly track: TrackType;
  readonly path: TrackPath;
  readonly state: YardState;
  readonly resolutionId: string | number;
  readonly isInspected: boolean;
  readonly onInspect: () => void;
  readonly onDismiss: () => void;
  readonly drawLength: number;
}

function getInspectionData(track: TrackType): TrackInspection {
  if (track.inspection) {
    return track.inspection;
  }
  return {
    quotedFee: "0.30% (3.00 USDC)",
    netAmountOut: track.landing ?? "0.00 USDC",
    disqualificationCode: track.chosen ? "WINNING_RAIL" : "PRICE_EXCEEDED",
    disqualificationReason:
      track.verdict?.note ?? (track.chosen ? "Optimal route chosen" : "Higher relative cost"),
    headroom: "10,000,000.00 USDC",
    latencyEstimate: track.waitsOnAttestation ? "13m attestation wait" : "5s deterministic ledger",
  };
}

export function Track({
  track,
  path,
  state,
  resolutionId,
  isInspected,
  onInspect,
  onDismiss,
  drawLength,
}: TrackProps): ReactElement {
  const drawn = track.chosen && state === "resolved";
  const className = [
    styles.track,
    drawn ? styles.trackChosen : null,
    drawn ? styles.trackDrawing : null,
    !drawn && track.verdict?.kind === "refusal" ? styles.trackRefused : null,
    !drawn && track.verdict?.kind !== "refusal" ? styles.trackLost : null,
    isInspected ? styles.trackInspected : null,
  ]
    .filter((name): name is string => name !== null)
    .join(" ");

  const offset = path.labelAbove ? -10 : 18;
  const note = drawn ? track.landing : (track.verdict?.note ?? null);
  const noteClass = drawn
    ? styles.annotationChosen
    : track.verdict?.kind === "refusal"
      ? styles.annotationRefusal
      : styles.annotationCost;

  const inspection = getInspectionData(track);
  const popoverWidth = 280;
  const popoverHeight = 84;
  const popoverX = path.labelX - popoverWidth / 2;
  const popoverY = path.labelAbove
    ? Math.max(6, path.labelY - 90)
    : Math.min(170, path.labelY + 16);

  const handleKeyDown = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (isInspected) {
        onDismiss();
      } else {
        onInspect();
      }
    } else if (e.key === "Escape") {
      onDismiss();
    }
  };

  return (
    <g
      className={styles.hitboxGroup}
      tabIndex={0}
      role="button"
      aria-label={`Inspect ${track.label} rail details`}
      aria-expanded={isInspected}
      onMouseEnter={onInspect}
      onMouseLeave={onDismiss}
      onFocus={onInspect}
      onBlur={onDismiss}
      onKeyDown={handleKeyDown}
    >
      <path
        key={drawn ? `chosen-${String(resolutionId)}` : `track-${String(track.route)}`}
        className={className}
        d={path.d}
        style={
          drawn
            ? {
                strokeDasharray: drawLength,
                ["--yard-draw-length" as string]: String(drawLength),
              }
            : undefined
        }
      />

      <path className={styles.hitbox} d={path.d} />

      <g key={`label-${String(track.route)}`}>
        <text
          className={`${styles.railName} ${drawn ? styles.railNameChosen : ""}`}
          x={path.labelX}
          y={path.labelY + offset}
          textAnchor="middle"
        >
          {track.label}
        </text>
        {note !== null && (
          <text
            className={`${styles.annotation} ${noteClass}`}
            x={path.labelX}
            y={path.labelY + offset + (path.labelAbove ? -14 : 14)}
            textAnchor="middle"
          >
            {note}
          </text>
        )}
      </g>

      {isInspected && (
        <g className={styles.popover} role="tooltip">
          <rect
            className={styles.popoverCard}
            x={popoverX}
            y={popoverY}
            width={popoverWidth}
            height={popoverHeight}
            rx={4}
          />
          <text className={styles.popoverTitle} x={popoverX + 12} y={popoverY + 18}>
            {track.label} {track.chosen ? "(winner)" : "(disqualified)"}
          </text>
          <text className={styles.popoverMono} x={popoverX + 12} y={popoverY + 34}>
            <tspan className={styles.popoverDim}>quoted fee: </tspan>
            <tspan className={styles.popoverVal}>{inspection.quotedFee}</tspan>
          </text>
          <text className={styles.popoverMono} x={popoverX + 12} y={popoverY + 48}>
            <tspan className={styles.popoverDim}>net out: </tspan>
            <tspan className={styles.popoverVal}>{inspection.netAmountOut}</tspan>
          </text>
          <text className={styles.popoverMono} x={popoverX + 12} y={popoverY + 62}>
            <tspan className={styles.popoverDim}>headroom: </tspan>
            <tspan className={styles.popoverVal}>{inspection.headroom}</tspan>
          </text>
          <text className={styles.popoverMono} x={popoverX + 12} y={popoverY + 76}>
            <tspan className={track.chosen ? styles.popoverBadgeOk : styles.popoverBadgeRefusal}>
              {inspection.disqualificationCode}:
            </tspan>
            <tspan className={styles.popoverReason}> {inspection.disqualificationReason}</tspan>
          </text>
        </g>
      )}
    </g>
  );
}

export default Track;

import type { SVGProps } from "react";

/**
 * The Hyperion mark: a monoline switch.
 *
 * One line comes in from the left. It reaches a solid junction node and forks. One branch leaves
 * to the right and keeps going. The other peels off at the same angle and stops short, because it
 * was priced and it lost.
 *
 * That is the entire product in nineteen points of geometry. Hyperion does not carry anything
 * across a chain boundary itself; it looks at four rails that already do, prices all four, and
 * throws a switch. A mark showing a bridge would be claiming something the architecture is
 * explicitly not doing.
 *
 * The geometry below is the single source of truth for the favicon set too.
 * `scripts/render-icons.py` reads this file, pulls the `d` attributes and the node circle straight
 * out of it, and fails loudly if it cannot find them, so the tab icon cannot drift away from the
 * mark in the header.
 *
 * Drawn on a 24 unit grid with a 2 unit stroke, which is 1.33px at a 16px render. The two branches
 * leave the node at 45 degrees in opposite directions and the only asymmetry is length: the chosen
 * branch runs to the edge of the box, the dropped one halts in open space. Legibility at 16px
 * comes from that difference in length rather than from a difference in weight, because a hairline
 * at 16px is a grey smudge and a shorter line is still a shorter line.
 */
export interface HyperionMarkProps extends Omit<SVGProps<SVGSVGElement>, "children" | "viewBox"> {
  /** Rendered size in pixels, square. Legible down to 16. */
  readonly size?: number;
  /**
   * An accessible name. Leave it off and the mark is hidden from assistive technology, which is
   * what you want when it sits next to the word Hyperion and would otherwise be read twice.
   */
  readonly label?: string;
}

export function HyperionMark({ size = 24, label, ...rest }: HyperionMarkProps) {
  const labelled = label !== undefined;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={labelled ? "img" : undefined}
      aria-label={labelled ? label : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      {...rest}
    >
      {/* The leg that arrives. */}
      <path d="M 2.5 12 H 8.1" />
      {/* The junction. Solid, because the decision is the only filled shape in the mark. */}
      <circle cx="10" cy="12" r="2.1" fill="currentColor" stroke="none" />
      {/* The rail that won, leaving the box. */}
      <path d="M 11.9 10.9 L 16.1 6.7 H 21.6" />
      {/* The rail that lost, stopping where it was turned down. */}
      <path d="M 11.9 13.1 L 15.5 16.7 H 17.8" />
    </svg>
  );
}

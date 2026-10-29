import type { SVGProps } from "react";

/** Monoline routing mark. The icon generator reads this geometry as its source of truth. */
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

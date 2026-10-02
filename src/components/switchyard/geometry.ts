/**
 * Where every line in the yard goes.
 *
 * Kept apart from the component because the geometry is the part worth getting right once. Four
 * tracks leave one node, run parallel for most of the span, and converge on another. Done badly
 * that reads as a bar chart lying on its side; done properly it reads as an interchange, and the
 * difference is entirely in where the curves start and how far the tracks are allowed to spread.
 *
 * The coordinate space is fixed and the SVG scales. Nothing here knows about pixels, which is why
 * the same numbers work full bleed on a desktop and in a phone's width.
 */

/** The drawing space. Wide and short, because the yard is a span rather than a panel. */
export const VIEW_WIDTH = 1000;
export const VIEW_HEIGHT = 260;

/** Where the two nodes sit. Inset enough that a label fits outside them. */
export const ORIGIN_X = 96;
export const DESTINATION_X = VIEW_WIDTH - 96;
export const CENTRE_Y = VIEW_HEIGHT / 2;

/** How far the outermost track strays from the centre line. */
const SPREAD = 66;

/**
 * How much of the span runs straight.
 *
 * The tracks fan out, run parallel, then converge. Without a parallel middle the whole thing is
 * two bundles of curves meeting in the centre, which looks like a bow tie rather than a yard.
 */
const FAN = 0.22;

export interface TrackPath {
  /** The SVG path, origin node to destination node. */
  readonly d: string;
  /** Where an annotation sits: the midpoint of the straight section. */
  readonly labelX: number;
  readonly labelY: number;
  /** Which side of the track the annotation should sit on, so it never lands on a line. */
  readonly labelAbove: boolean;
}

/**
 * The path for one track out of `count`.
 *
 * Index zero is the topmost. Offsets are spread evenly across the full width so an odd count puts
 * one track dead centre and an even count straddles it, which is what makes four tracks look
 * deliberate rather than like three tracks and a spare.
 */
export function trackPath(index: number, count: number): TrackPath {
  const offset = count === 1 ? 0 : (index / (count - 1) - 0.5) * 2 * SPREAD;
  const y = CENTRE_Y + offset;

  const span = DESTINATION_X - ORIGIN_X;
  const fanEnd = ORIGIN_X + span * FAN;
  const convergeStart = DESTINATION_X - span * FAN;

  // A cubic on each end with its control points pulled horizontally, so a track leaves the node
  // level and arrives level. Pulling them vertically instead produces an S that reads as a wire
  // under tension rather than as a rail.
  const control = span * FAN * 0.55;

  const d = [
    `M ${String(ORIGIN_X)} ${String(CENTRE_Y)}`,
    `C ${String(ORIGIN_X + control)} ${String(CENTRE_Y)}`,
    `${String(fanEnd - control)} ${String(y)}`,
    `${String(fanEnd)} ${String(y)}`,
    `L ${String(convergeStart)} ${String(y)}`,
    `C ${String(convergeStart + control)} ${String(y)}`,
    `${String(DESTINATION_X - control)} ${String(CENTRE_Y)}`,
    `${String(DESTINATION_X)} ${String(CENTRE_Y)}`,
  ].join(" ");

  return {
    d,
    labelX: (fanEnd + convergeStart) / 2,
    labelY: y,
    // Above for the tracks in the top half, below for the bottom half, so an annotation always
    // moves away from the centre line and never crosses a neighbouring track.
    labelAbove: offset <= 0,
  };
}

/**
 * Roughly how long a path is, for the draw-in animation.
 *
 * `getTotalLength` would be exact, but it needs a laid out DOM node and the animation has to be
 * declared in CSS before the browser paints, or the first frame shows a fully drawn line and the
 * draw never happens. An over estimate is harmless here: `stroke-dasharray` just means the dash
 * is longer than it needs to be, and the line still arrives at the same moment.
 */
export function pathLengthEstimate(): number {
  return DESTINATION_X - ORIGIN_X + SPREAD * 2;
}

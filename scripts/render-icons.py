#!/usr/bin/env python3
"""Render the favicon set from the mark component, rather than from a second drawing of it.

There is no SVG rasteriser on this machine and no appetite for adding one, so this script reads
``src/components/brand/HyperionMark.tsx``, pulls the geometry straight out of the JSX, and draws it
with Pillow. The component stays the single source of truth: change the mark and the tab icon
follows, and if the geometry ever stops being extractable the script fails instead of quietly
shipping yesterday's icon.

It also writes ``public/icon.svg`` from the same numbers, so the vector favicon and the raster ones
cannot disagree either.

Outputs:

  public/icon.svg            vector, copper mark on the page ink
  public/favicon.ico         16, 32 and 48, which is what a browser tab actually asks for
  public/apple-touch-icon.png  180, which is what iOS asks for

Run with ``npm run icons``. Pillow only, no network.
"""

from __future__ import annotations

import re
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
COMPONENT = ROOT / "src" / "components" / "brand" / "HyperionMark.tsx"
TOKENS = ROOT / "src" / "app" / "tokens.ts"
PUBLIC = ROOT / "public"

GRID = 24.0
STROKE = 2.0

# Supersample before downsampling. A monoline mark at 16px lives or dies on its antialiasing, and
# drawing at 16x and resampling with LANCZOS beats anything Pillow will do with a 1.33px line.
OVERSAMPLE = 16


def read_token(name: str) -> tuple[int, int, int]:
    """Pull a hex colour out of the TypeScript token module, which is the declared exception."""
    source = TOKENS.read_text(encoding="utf8")
    match = re.search(rf"^export const {name} = \"(#[0-9a-fA-F]{{6}})\";$", source, re.M)
    if match is None:
        raise SystemExit(f"{TOKENS.name}: no export named {name}")
    value = match.group(1).lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def parse_path(d: str) -> list[tuple[float, float]]:
    """Parse the three path commands this mark uses, and refuse anything else.

    Supporting the whole of the SVG path grammar here would be a quiet invitation to draw a curve
    in the component and get a straight line in the favicon. M, L and H are what the mark uses, so
    M, L and H are what this understands.
    """
    points: list[tuple[float, float]] = []
    tokens = d.replace(",", " ").split()
    i = 0
    while i < len(tokens):
        command = tokens[i]
        if command in ("M", "L"):
            points.append((float(tokens[i + 1]), float(tokens[i + 2])))
            i += 3
        elif command == "H":
            if not points:
                raise SystemExit(f"path starts with H, which has no y to inherit: {d}")
            points.append((float(tokens[i + 1]), points[-1][1]))
            i += 2
        else:
            raise SystemExit(f"unsupported path command {command!r} in {d!r}")
    return points


def read_geometry() -> tuple[list[list[tuple[float, float]]], tuple[float, float, float]]:
    """Extract the polylines and the junction node out of the component."""
    source = COMPONENT.read_text(encoding="utf8")

    paths = re.findall(r'<path d="([^"]+)"\s*/>', source)
    if len(paths) != 3:
        raise SystemExit(f"{COMPONENT.name}: expected 3 paths in the mark, found {len(paths)}")

    node = re.search(
        r'<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"', source
    )
    if node is None:
        raise SystemExit(f"{COMPONENT.name}: no junction circle found")

    polylines = [parse_path(d) for d in paths]
    return polylines, (float(node.group(1)), float(node.group(2)), float(node.group(3)))


def stroke_for(size: int) -> float:
    """How thick the line should be, in grid units, for a given output size.

    At 48px and up the component's own 2 units is right. Below that it is too thin to survive the
    downsample, so it is nudged up. This is the one place the icon is allowed to differ from the
    component, and it differs in weight only, never in shape: the geometry is identical at every
    size and only the pen changes.
    """
    if size <= 16:
        return STROKE * 1.35
    if size <= 32:
        return STROKE * 1.15
    return STROKE


def render(size: int, ink: tuple[int, int, int], copper: tuple[int, int, int]) -> Image.Image:
    polylines, (cx, cy, radius) = read_geometry()
    big = size * OVERSAMPLE
    scale = big / GRID

    canvas = Image.new("RGBA", (big, big), (*ink, 255))
    draw = ImageDraw.Draw(canvas)
    width = max(1, round(stroke_for(size) * scale))

    for points in polylines:
        scaled = [(x * scale, y * scale) for x, y in points]
        draw.line(scaled, fill=(*copper, 255), width=width, joint="curve")
        # Pillow has no round line cap, so the caps are drawn as discs at every vertex. Without
        # these the joins show as notches at the two bends, which is exactly where the eye goes.
        for x, y in scaled:
            r = width / 2
            draw.ellipse((x - r, y - r, x + r, y + r), fill=(*copper, 255))

    r = radius * scale
    draw.ellipse(
        (cx * scale - r, cy * scale - r, cx * scale + r, cy * scale + r), fill=(*copper, 255)
    )

    return canvas.resize((size, size), Image.LANCZOS)


def write_svg(ink: str, copper: str) -> None:
    polylines, (cx, cy, radius) = read_geometry()
    paths = "\n".join(
        '    <polyline points="{}" />'.format(" ".join(f"{x},{y}" for x, y in points))
        for points in polylines
    )
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <title>Hyperion</title>
  <rect width="24" height="24" fill="{ink}" />
  <g fill="none" stroke="{copper}" stroke-width="{STROKE}" stroke-linecap="round" stroke-linejoin="round">
{paths}
  </g>
  <circle cx="{cx}" cy="{cy}" r="{radius}" fill="{copper}" />
</svg>
"""
    (PUBLIC / "icon.svg").write_text(svg, encoding="utf8")


def main() -> None:
    PUBLIC.mkdir(exist_ok=True)
    ink = read_token("PAGE_INK")
    copper = read_token("SIGNAL_COPPER")

    write_svg("#%02x%02x%02x" % ink, "#%02x%02x%02x" % copper)

    frames = [render(size, ink, copper) for size in (16, 32, 48)]
    frames[0].save(PUBLIC / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])

    render(180, ink, copper).save(PUBLIC / "apple-touch-icon.png", format="PNG", optimize=True)

    # A contact sheet, for looking at the thing at the sizes that matter before trusting it.
    sheet = Image.new("RGBA", (16 + 32 + 48 + 180 + 5 * 12, 180 + 24), (*ink, 255))
    x = 12
    for size in (16, 32, 48, 180):
        sheet.paste(render(size, ink, copper), (x, 12 + (180 - size) // 2))
        x += size + 12
    sheet.save(PUBLIC / ".icon-contact-sheet.png", format="PNG")

    print("wrote public/icon.svg, public/favicon.ico (16, 32, 48), public/apple-touch-icon.png")


if __name__ == "__main__":
    main()

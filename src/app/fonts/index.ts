import localFont from "next/font/local";

/**
 * The two faces, loaded from files that live in this repository.
 *
 * Roll 3 of the locked design plan is grotesk display plus monospace as the working face, which
 * means the mono is not code decoration here. Every amount, address, chain id, CCTP domain, ledger
 * count, rail name and status word in the app is set in IBM Plex Mono, because every single fact
 * in a bridge interface is a number or an identifier and setting them in a proportional face
 * throws away the one property that makes them comparable: a column of digits that lines up.
 *
 * Why local files and not `next/font/google`:
 *
 * - `next/font/google` fetches at build time. That makes a build depend on fonts.gstatic.com being
 *   reachable, which is a strange thing for a deploy to fail on.
 * - These files came out of `npm pack @fontsource-variable/archivo` and
 *   `npm pack @fontsource/ibm-plex-mono`, not out of a browser. Archivo is the variable weight
 *   axis, one file for 100 to 900, which is why the display weights cost nothing extra. IBM Plex
 *   Mono has no variable build on fontsource, so 400, 500 and 600 ship as three static files.
 *   Four files, about 80 KB in total, latin subset only.
 * - `adjustFontFallback` generates a metric matched fallback face, so the text does not reflow when
 *   the real file arrives. Combined with `preload` and a same origin request, the swap window is
 *   short enough that there is nothing to see.
 */
export const archivo = localFont({
  src: [{ path: "./archivo-variable-latin.woff2", weight: "100 900", style: "normal" }],
  variable: "--font-display",
  display: "swap",
  preload: true,
  adjustFontFallback: "Arial",
  fallback: ["system-ui", "Segoe UI", "Helvetica Neue", "sans-serif"],
});

export const plexMono = localFont({
  src: [
    { path: "./ibm-plex-mono-400-latin.woff2", weight: "400", style: "normal" },
    { path: "./ibm-plex-mono-500-latin.woff2", weight: "500", style: "normal" },
    { path: "./ibm-plex-mono-600-latin.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-mono",
  display: "swap",
  preload: true,
  adjustFontFallback: "Arial",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
});

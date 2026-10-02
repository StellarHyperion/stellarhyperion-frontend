import type { Metadata, Viewport } from "next";
import { archivo, plexMono } from "./fonts";
import { PAGE_INK } from "./tokens";
import "./globals.css";

/**
 * The tab title says what the thing is rather than what it would like to be. No em dash, no
 * pipe separated tagline, no "the future of" anything.
 */
export const metadata: Metadata = {
  title: {
    default: "Hyperion, a router for Stellar and EVM",
    template: "%s / Hyperion",
  },
  description:
    "Hyperion prices four audited cross-chain rails locally and takes the one that lands the most money. It does not run a validator set of its own.",
  applicationName: "Hyperion",
  authors: [{ name: "dotmantissa" }],
  // Generated from the mark component by `npm run icons`, so the tab and the header cannot drift.
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: PAGE_INK,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import { archivo, plexMono } from "./fonts";
import { PAGE_INK } from "./tokens";
import { Providers } from "./providers";
import { Footer, Header, Main, Shell } from "../components/chrome";
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
    "Stellar testnet transfers through configured Axelar ITS lanes, with wallet signing and on-chain transaction tracking.",
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
  colorScheme: "dark light",
  themeColor: PAGE_INK,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      suppressHydrationWarning
      className={`${archivo.variable} ${plexMono.variable}`}
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              '(function(){try{var t=localStorage.getItem("hyperion.theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();',
          }}
        />
      </head>
      <body>
        <Providers>
          <a className="skipLink" href="#main-content">
            Skip to main content
          </a>
          <Shell>
            <Header network="Stellar Testnet" />
            <Main>{children}</Main>
            <Footer />
          </Shell>
        </Providers>
      </body>
    </html>
  );
}

import type { NextConfig } from "next";

/**
 * Deliberately short.
 *
 * `reactStrictMode` is on because the switchyard replays its draw animation on a remount, and
 * strict mode's double invoke in development is the cheapest way to find out that the replay is
 * keyed wrong. `poweredByHeader` is off because announcing the framework in a response header has
 * never helped anybody but a scanner.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  // Pinned because this app lives in a sibling directory to the contracts repo and Turbopack
  // otherwise walks up looking for a lockfile, finds one in a home directory, and warns about it
  // on every build. The root is this package, full stop.
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;

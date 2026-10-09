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
  // The parent directory, not this one, and that is load bearing rather than tidy.
  //
  // `@hyperion/protocol` is a file dependency on a sibling repository, so npm installs it as a
  // symlink that resolves to a real path outside this package. Turbopack will not follow a symlink
  // out of its root, so pinning the root here makes the shared SDK unresolvable and the build
  // fails with a bare "module not found" that says nothing about symlinks. Pointing at the
  // directory that actually contains both repositories is what a workspace root means.
  //
  // Setting it explicitly still does the job it was added for, which is stopping Turbopack from
  // walking up into a home directory looking for a lockfile and warning on every build.
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  agentRules: false,
  // Budget attribution uses the modules in the emitted, mangled client chunks.
  productionBrowserSourceMaps: true,
  // The protocol tarball is installed inside this package.
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  agentRules: false,
  // The protocol tarball is installed inside this package.
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;

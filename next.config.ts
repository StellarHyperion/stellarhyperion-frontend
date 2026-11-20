import type { NextConfig } from "next";
import deployment from "./src/config/testnet-deployment.json";

const stellarDeployment = deployment.networks["stellar-testnet"];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  agentRules: false,
  // Budget attribution uses the modules in the emitted, mangled client chunks.
  productionBrowserSourceMaps: true,
  // Keep cached clients on a consistent deployment revision during rolling updates.
  deploymentId: stellarDeployment.commit,
  // The protocol tarball is installed inside this package.
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow teammates on the LAN (and over ZeroTier) to load the dev server.
  // Next blocks cross-origin requests to dev assets unless the origin is listed.
  allowedDevOrigins: ["192.168.3.228", "192.168.192.101"],
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // Pinned, because Turbopack infers the root from the nearest lockfile and
    // there is a stray package-lock.json in C:\Users\mark (a one-off tailwind
    // install). Left inferred, Turbopack roots itself at the whole user profile
    // and watches Desktop/Downloads/AppData along with it — slow cold boots and,
    // worse, dropped watcher events that leave routes unregistered, which shows
    // up as an intermittent 404 on a page that plainly exists.
    root: __dirname,
  },
  // Allow teammates on the LAN (and over ZeroTier) to load the dev server.
  // Next blocks cross-origin requests to dev assets unless the origin is listed.
  allowedDevOrigins: ["192.168.3.228", "192.168.192.101"],
};

export default nextConfig;

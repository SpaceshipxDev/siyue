import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    viewTransition: true,
  },
  async headers() {
    return [
      {
        // The STEP engine (7.6MB WASM + loader + worker) has stable filenames and
        // changes only when the lib is bumped — cache it hard so it loads once ever.
        // If you ever replace these assets, rename them to bust the cache.
        source: "/:asset(occt-import-js\\.js|occt-import-js\\.wasm|occt\\.worker\\.js)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
};

export default nextConfig;

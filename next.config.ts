import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    viewTransition: true,
    // Order workbooks (报价单/生产单) carry embedded part photos and routinely
    // exceed Next's default 10MB buffered-body cap. Past the cap the body is
    // silently truncated, so /api/ingest's request.formData() then throws
    // "Failed to parse body as FormData" and the import fails. Lift it to fit
    // image-heavy xlsx. (Applies because the app buffers the request body via
    // proxy; see docs/…/proxyClientMaxBodySize.)
    proxyClientMaxBodySize: '50mb',
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

const isDevelopment = process.env.NODE_ENV !== "production";

// Defence in depth behind the diagram sanitization pipeline: if a DOMPurify
// bypass ever lands, `connect-src 'self'` still denies the injected code any
// way to phone home, and object/base/form rules deny the usual pivots.
//
// `script-src` keeps 'unsafe-inline' because Next.js emits inline bootstrap
// scripts; tightening it further requires nonces, which need a middleware that
// can stamp each response.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
  // Tailwind and Mermaid's themeCSS both inject style elements at runtime.
  "style-src 'self' 'unsafe-inline'",
  // blob: and data: carry the rendered SVG through the PNG export path.
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  // Same-origin frames only: the explainer video stage (/video-engine).
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  // Safari upgrades localhost assets to HTTPS too, which breaks HTTP dev servers.
  ...(isDevelopment ? [] : ["upgrade-insecure-requests"]),
].join("; ");

// The explainer stage renders model-written text, so it gets a stricter policy
// than the app: only same-origin script files run (no inline scripts or
// handlers), nothing can be fetched, and only our own pages may frame it.
const videoStagePolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

// MP4 renders use ffmpeg-static, a native binary that must stay out of the
// bundle and be traced into the functions that run it (the Chromium that draws
// the frames is the host's own, VIDEO_RENDER_CHROME_PATH). The glob also
// matches ffmpeg.exe, the Windows binary. The render and generate routes only
// mix and join with ffmpeg; their code (ffmpeg.ts) never imports the
// Chromium half (render.ts), and scripts/check-video-render-tracing.mjs keeps
// it that way.
const ffmpegFiles = ["./node_modules/ffmpeg-static/ffmpeg*"];

/** @type {import("next").NextConfig} */
const config = {
  reactStrictMode: false,
  serverExternalPackages: ["puppeteer-core", "ffmpeg-static"],
  outputFileTracingIncludes: {
    "/api/video/render": ffmpegFiles,
    "/api/video/render/segment": ffmpegFiles,
    "/api/video/generate": ffmpegFiles,
  },
  // A dynamic file path in a server module makes Turbopack trace that
  // module's whole folder (tests included). The bundles already hold the code.
  outputFileTracingExcludes: {
    "/**": ["./src/**"],
  },
  allowedDevOrigins: ["127.0.0.1"],
  // The IIS package runs the self-contained server.js from .next/standalone.
  output: "standalone",
  async redirects() {
    return [
      // The video gallery moved from /watch to /videos.
      {
        source: "/:path(watch|video)",
        destination: "/videos",
        permanent: true,
      },
      // Support replacing github.com in a file, branch, issue or pull-request URL.
      {
        source: "/:username/:repo/twitter-image",
        destination: "/:username/:repo/opengraph-image",
        permanent: true,
      },
      {
        source:
          "/:username/:repo/:view(tree|blob|issues|pull|pulls|commit|commits|releases|actions)/:path*",
        destination: "/:username/:repo",
        permanent: false,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/favicon.ico",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, stale-while-revalidate=604800",
          },
        ],
      },
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
      // Must follow the catch-all rule: later rules override the same header.
      {
        source: "/video-engine/:path*",
        headers: [
          { key: "Content-Security-Policy", value: videoStagePolicy },
          // Engine code changes with the app, so it always revalidates.
          { key: "Cache-Control", value: "no-cache" },
        ],
      },
      {
        source: "/video-engine/assets/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, stale-while-revalidate=604800",
          },
        ],
      },
    ];
  },
};

export default config;

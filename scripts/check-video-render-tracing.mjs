// Run after `bun run build`. The MP4 renderer needs the ffmpeg binary, which
// Next only ships because next.config.js lists it in outputFileTracingIncludes.
// Both failure modes are silent: ffmpeg-static only warns when its binary
// download fails, and a traced path that does not exist is skipped. Either way
// renders fail in production, so fail the build here.
//
// The other way round, the render and generate routes only join segments: they
// must not ship the JS that launches Chromium (puppeteer-core), and no render
// function may quietly grow past its size ceiling.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Real binaries are tens of megabytes; anything tiny is a stub or a failed
// download.
const ffmpeg = {
  // The Windows binary has an extension.
  file: `node_modules/ffmpeg-static/ffmpeg${process.platform === "win32" ? ".exe" : ""}`,
  minBytes: 10_000_000,
};

// Anything under these paths means a function ships the Chromium launcher.
const chromiumPackages = ["node_modules/puppeteer-core/"];

const MB = 1_000_000;

// The render route only joins segments, so it ships ffmpeg alone; Chromium
// runs in the segment route (frames and posters). Generate needs ffmpeg for
// the narration and asks the segment route for its poster, so it ships no
// Chromium launcher either. Ceilings are the traced files' total size on disk
// (uncompressed) apart from the ffmpeg binary, whose size depends on the
// platform (about 46 MB on macOS, 80 MB on Linux CI; no Chromium is bundled), with some room over
// today's size; raise one only on purpose.
const routes = [
  {
    route: "api/video/render",
    requiredFiles: [ffmpeg],
    forbidden: chromiumPackages,
    maxBytes: 15 * MB,
  },
  {
    route: "api/video/render/segment",
    requiredFiles: [ffmpeg],
    forbidden: [],
    maxBytes: 12 * MB,
  },
  {
    route: "api/video/generate",
    requiredFiles: [ffmpeg],
    forbidden: chromiumPackages,
    maxBytes: 15 * MB,
  },
];

const failures = [];
const sizes = [];

for (const { route, requiredFiles, forbidden, maxBytes } of routes) {
  const nftFile = `.next/server/app/${route}/route.js.nft.json`;
  if (!existsSync(nftFile)) {
    failures.push(`${nftFile} is missing. Run the production build first.`);
    continue;
  }
  const { files } = JSON.parse(readFileSync(nftFile, "utf8"));
  const traced = new Set(
    files.map((file) =>
      path.relative(".", path.resolve(path.dirname(nftFile), file)),
    ),
  );
  for (const { file, minBytes } of requiredFiles) {
    if (!traced.has(path.normalize(file))) {
      failures.push(`/${route} does not trace ${file}.`);
      continue;
    }
    const bytes = existsSync(file) ? statSync(file).size : 0;
    if (bytes < minBytes) {
      failures.push(
        `${file} is ${bytes} bytes (expected at least ${minBytes}); the binary is missing or incomplete.`,
      );
    }
  }
  const shipped = [...traced].filter((file) =>
    forbidden.some((prefix) => file.startsWith(path.normalize(prefix))),
  );
  if (shipped.length) {
    failures.push(
      `/${route} must not ship the Chromium launcher, but traces ${shipped.slice(0, 5).join(", ")}${shipped.length > 5 ? ` and ${shipped.length - 5} more` : ""}.`,
    );
  }
  let bytes = 0;
  for (const file of traced) {
    if (file === path.normalize(ffmpeg.file)) continue;
    const stats = existsSync(file) ? statSync(file) : null;
    if (stats?.isFile()) bytes += stats.size;
  }
  sizes.push({ route: `/${route}`, files: traced.size, bytes, maxBytes });
  if (bytes > maxBytes) {
    failures.push(
      `/${route} traces ${bytes} bytes across ${traced.size} files (ceiling ${maxBytes}).`,
    );
  }
}

console.log(JSON.stringify(sizes, null, 2));

if (failures.length) {
  console.error(
    `Video render tracing check failed:\n- ${[...new Set(failures)].join("\n- ")}`,
  );
  process.exitCode = 1;
} else {
  console.log(
    "Video render routes trace the ffmpeg binary they need and keep the Chromium launcher out of the render and generate routes.",
  );
}

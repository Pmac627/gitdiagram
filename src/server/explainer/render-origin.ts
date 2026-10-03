import "server-only";

// An MP4 render calls back into the site: the render route posts segments to
// the segment route, Chromium loads the stage, and the soundtrack fetches its
// effect sounds. Every one of those calls must reach the server at an address
// it can call itself on.

/**
 * The origin the server calls itself on. A standalone production server
 * listens on 0.0.0.0, which Next puts into request.url and recent Chromium
 * refuses to load, so there it is loopback on the server's own port (PORT,
 * trimmed). Otherwise it is the origin of the request.
 * VIDEO_INTERNAL_ORIGIN overrides both.
 */
export function internalOrigin(request: Request): string {
  const configured = process.env.VIDEO_INTERNAL_ORIGIN?.trim();
  if (configured) return new URL(configured).origin;
  const port = process.env.PORT?.trim();
  if (process.env.NODE_ENV === "production" && port)
    return `http://127.0.0.1:${port}`;
  return new URL(request.url).origin;
}

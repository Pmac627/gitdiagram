import { z } from "zod";
import { requireOperator } from "~/server/auth/require-operator";

import {
  githubRepoSchema,
  githubUsernameSchema,
} from "~/server/generate/types";
import { PICTURE_ID } from "~/features/explainer/types";
import { jsonErrorResponse } from "~/server/http/same-origin-json";
import { isVideoExplainerEnabled } from "~/server/explainer/config";
import { probePicture } from "~/server/explainer/readme-images";
import {
  readPicture,
  readRender,
  readVideoArtifact,
  renderSize,
  streamRender,
  type RenderName,
} from "~/server/explainer/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const querySchema = z.object({
  username: githubUsernameSchema,
  repo: githubRepoSchema,
  format: z.enum(["landscape", "vertical", "poster", "still", "picture"]),
  // A README picture the film shows (format "picture").
  id: z.string().regex(PICTURE_ID).optional(),
  // The video's createdAt: renders live under their video's version folder.
  // Only a poster may leave it out, for the latest video's poster (a README
  // picture that must keep working when the video is made again).
  v: z.iso.datetime().optional(),
  // When a poster or still was made. A remake keeps the file's name, so this
  // is what gives it a new URL.
  p: z
    .string()
    .regex(/^\d{1,16}$/)
    .optional(),
});

const FILES: Record<"landscape" | "vertical" | "poster" | "still", RenderName> =
  {
    landscape: "landscape.mp4",
    vertical: "vertical.mp4",
    poster: "poster.jpg",
    still: "still.jpg",
  };

type ByteRange = { start: number; end: number } | "unsatisfiable" | null;

/**
 * The single byte range a Range header asks for, clamped to the file, or
 * "unsatisfiable" when it starts past the end. Null when the header is absent
 * or is not one single "bytes=" range (a browser then gets the whole file).
 */
function parseRange(header: string | null, size: number): ByteRange {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;

  if (!match || (match[1] === "" && match[2] === "")) {
    return null;
  }

  if (match[1] === "") {
    const suffix = Number(match[2]);

    return suffix === 0 || size === 0
      ? "unsatisfiable"
      : { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Number(match[2]);

  if (start >= size || end < start) {
    return "unsatisfiable";
  }

  return { start, end: Math.min(end, size - 1) };
}

/**
 * A stored render. Posters are small and sent whole (they feed link
 * previews). MP4s stream from disk in chunks, and answer Range requests so a
 * player can seek.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = await requireOperator(request);
  if (denied) return denied;

  if (!isVideoExplainerEnabled())
    return jsonErrorResponse("Explainer videos are not enabled.", 404);
  const url = new URL(request.url);
  const parsed = querySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsed.success) return jsonErrorResponse("Invalid file request.", 400);
  const { username, repo, format, v, p, id } = parsed.data;
  const latest = !v;
  if (latest && format !== "poster")
    return jsonErrorResponse("Invalid file request.", 400);
  if (format === "picture") {
    // Named by the video version, so the bytes behind a URL never change.
    const body = id && v ? await readPicture(username, repo, v, id) : null;
    // Its type comes from its own bytes, checked when it was stored.
    const picture = body && probePicture(body);
    if (!body || !picture)
      return jsonErrorResponse("This picture does not exist.", 404);
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": picture.type,
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  const artifact = await readVideoArtifact(username, repo);
  if (!artifact) return jsonErrorResponse("This video does not exist.", 404);
  const version = { ...artifact, createdAt: v ?? artifact.createdAt };
  const name = FILES[format];
  const filename = `${artifact.meta.owner}-${artifact.meta.repo}-explained${format === "vertical" ? "-vertical" : ""}.mp4`;
  const missing = () =>
    jsonErrorResponse("This file has not been made yet.", 404);

  const mp4 = format === "landscape" || format === "vertical";
  if (mp4) {
    const size = await renderSize(version, name);
    if (size === null) return missing();

    const range = parseRange(request.headers.get("range"), size);
    const headers = {
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Accept-Ranges": "bytes",
      // Only local storage serves MP4s, and its URL does not name the engine
      // that drew the file.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };

    if (range === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${size}` },
      });
    }
    if (range) {
      return new Response(streamRender(version, name, range), {
        status: 206,
        headers: {
          ...headers,
          "Content-Length": String(range.end - range.start + 1),
          "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        },
      });
    }
    return new Response(size === 0 ? null : streamRender(version, name), {
      headers: { ...headers, "Content-Length": String(size) },
    });
  }
  const body = await readRender(version, name);
  if (!body) return missing();
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(body.byteLength),
      "Cache-Control":
        !latest && p
          ? // The URL names the video version and when the poster was made,
            // so its bytes never change.
            "private, max-age=31536000, immutable"
          : // Whichever video is current, or a poster without a stamp (a remade
            // one would reuse the URL): browsers check back within the hour.
            "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

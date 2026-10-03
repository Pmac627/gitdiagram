import { type NextRequest, NextResponse } from "next/server";

import { safeNextPath } from "~/lib/safe-next-path";
import { verifyAdminRequest } from "~/server/auth/operator";

const REJECTION_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function privatePassThrough(): NextResponse {
  const response = NextResponse.next();

  response.headers.set("Cache-Control", "private, no-store");

  return response;
}

/**
 * GitDiagram does not expose Server Actions. Reject forged action requests at
 * the proxy boundary so they never reach the Next.js action decoder.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (request.headers.has("next-action")) {
    return new NextResponse(null, {
      status: 404,
      headers: REJECTION_HEADERS,
    });
  }

  const path = request.nextUrl.pathname;

  // The renderer authenticates this one route with its own signed job token.
  if (path === "/api/video/render/segment") {
    return privatePassThrough();
  }

  if (!(await verifyAdminRequest(request))) {
    if (path.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Sign in as the operator." },
        { status: 401, headers: REJECTION_HEADERS },
      );
    }

    const target = request.nextUrl.clone();
    const next = safeNextPath(`${path}${request.nextUrl.search}`);

    target.pathname = "/sign-in";
    target.search = next === "/" ? "" : `?next=${encodeURIComponent(next)}`;

    const response = NextResponse.redirect(target, 307);
    response.headers.set("Cache-Control", "no-store");

    return response;
  }

  if (request.method === "GET" || request.method === "HEAD") {
    const url = request.nextUrl.clone();

    if (
      !/^\/(?:api|_next)\//i.test(path) &&
      /^\/[^/]+\/[^/]+(?:\/opengraph-image)?\/?$/.test(path) &&
      path !== path.toLowerCase()
    ) {
      url.pathname = path.toLowerCase();

      const response = NextResponse.redirect(url, 308);

      response.headers.set("Cache-Control", "private, no-store");

      return response;
    }
  }

  return privatePassThrough();
}

export const config = {
  matcher:
    "/((?!_next/static(?:/|$)|_next/image(?:/|$)|favicon\\.ico$|video-engine(?:/|$)|sign-in(?:/|$)|api/auth(?:/|$)|api/healthz$).*)",
};

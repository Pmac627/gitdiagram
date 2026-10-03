import { z } from "zod";

import {
  ADMIN_SESSION_COOKIE,
  createAdminSession,
  isOperatorConfigured,
  isOperatorToken,
  revokeAdminSessions,
  verifyAdminRequest,
} from "~/server/auth/operator";
import { checkSignIn } from "~/server/auth/sign-in-guard";
import { isSameOriginRequest } from "~/server/http/same-origin";
import {
  jsonErrorResponse,
  NO_STORE_RESPONSE_HEADERS,
  parseSameOriginJsonRequest,
} from "~/server/http/same-origin-json";

import { errorText } from "~/server/log";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.strictObject({ token: z.string().min(1).max(512) });

function cookie(value: string, maxAgeSeconds: number): string {
  return [
    `${ADMIN_SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; ");
}

/**
 * Whether this browser has an operator session.
 */
export async function GET(request: Request): Promise<Response> {
  return Response.json(
    { ok: true, admin: await verifyAdminRequest(request) },
    { headers: NO_STORE_RESPONSE_HEADERS },
  );
}

/** Sign in with the operator token. @see docs/flows/operator-live-ops.md */
export async function POST(request: Request): Promise<Response> {
  const parsed = await parseSameOriginJsonRequest(request, {
    schema: requestSchema,
    maxBytes: 1024,
    crossOriginError: "Sign in from GitDiagram.",
  });
  if (!parsed.success) return parsed.response;
  if (!isOperatorConfigured()) {
    // A missing or short token leaves the site closed.
    console.warn(
      JSON.stringify({
        event: "admin.not_configured",
        reason: (
          process.env.OPERATOR_TOKEN ?? process.env.VIDEO_ADMIN_TOKEN
        )?.trim()
          ? "token_too_short"
          : "token_missing",
      }),
    );
    return jsonErrorResponse(
      "The site is not set up. OPERATOR_TOKEN needs at least 40 characters.",
      503,
    );
  }
  const correct = isOperatorToken(parsed.data.token);
  const check = await checkSignIn(request, correct);
  if (check.blocked) {
    const minutes = Math.max(1, Math.ceil(check.retryAfterSeconds / 60));
    const response = jsonErrorResponse(
      `Too many tries. Wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`,
      429,
    );
    response.headers.set("Retry-After", String(check.retryAfterSeconds));
    return response;
  }
  if (!correct) {
    // Slow down guessing; the token is far too long to guess anyway.
    await new Promise((resolve) => setTimeout(resolve, 750));
    return jsonErrorResponse("That token is not right.", 401);
  }
  const session = await createAdminSession();
  if (!session)
    return jsonErrorResponse("The session store is unavailable.", 503);
  return Response.json(
    { ok: true },
    {
      headers: {
        ...NO_STORE_RESPONSE_HEADERS,
        "Set-Cookie": cookie(session.value, session.maxAgeSeconds),
      },
    },
  );
}

/**
 * Sign out. With ?everywhere=1, every browser signed in to /admin is signed
 * out too (needs a valid session and writable SQLite storage).
 */
export async function DELETE(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request))
    return jsonErrorResponse("Sign out from GitDiagram.", 403);
  if (new URL(request.url).searchParams.get("everywhere") === "1") {
    if (!(await verifyAdminRequest(request)))
      return jsonErrorResponse("Sign in first.", 401);
    try {
      await revokeAdminSessions();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "admin.sign_out_everywhere_failed",
          error: errorText(error),
        }),
      );
      return jsonErrorResponse(
        "Could not sign out everywhere. Try again.",
        503,
      );
    }
  }
  return Response.json(
    { ok: true },
    { headers: { ...NO_STORE_RESPONSE_HEADERS, "Set-Cookie": cookie("", 0) } },
  );
}

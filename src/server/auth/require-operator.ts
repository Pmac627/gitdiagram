import "server-only";

import { verifyAdminRequest } from "~/server/auth/operator";
import { NO_STORE_RESPONSE_HEADERS } from "~/server/http/same-origin-json";

/**
 * Require the operator session cookie. An `Authorization` header is never read.
 * @see docs/flows/operator-live-ops.md
 */
export async function requireOperator(
  request: Request,
): Promise<Response | null> {
  if (await verifyAdminRequest(request)) {
    return null;
  }

  return Response.json(
    { error: "Sign in as the operator." },
    { status: 401, headers: NO_STORE_RESPONSE_HEADERS },
  );
}

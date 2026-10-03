import { requireOperator } from "~/server/auth/require-operator";
import { readAdminState } from "~/server/admin/state";
import { NO_STORE_RESPONSE_HEADERS } from "~/server/http/same-origin-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/** The dashboard's polled state: the voice balance and its pause. */
export async function GET(request: Request): Promise<Response> {
  const denied = await requireOperator(request);
  if (denied) return denied;
  return Response.json(await readAdminState(), {
    headers: NO_STORE_RESPONSE_HEADERS,
  });
}

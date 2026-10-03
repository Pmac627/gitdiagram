import { NextResponse } from "next/server";

import { verifyAdminRequest } from "~/server/auth/operator";
import { checkReadiness } from "~/server/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Uptime check. The proxy does not gate this route, so an anonymous caller gets
 * only `{ ok }`; a signed-in operator also gets the per-check results.
 * @see docs/operations/index.md
 */
export async function GET(request: Request): Promise<NextResponse> {
  const readiness = await checkReadiness();
  const operator = await verifyAdminRequest(request);

  return NextResponse.json(
    operator
      ? { ok: readiness.ok, checks: readiness.checks }
      : { ok: readiness.ok },
    {
      status: readiness.ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

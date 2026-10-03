import { jsonErrorResponse } from "~/server/http/same-origin-json";
import { requireOperator } from "~/server/auth/require-operator";
import { getVideoPage } from "~/server/explainer/catalog";
import { isVideoExplainerEnabled } from "~/server/explainer/config";
import { errorText, logEvent } from "~/server/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * One page of the /videos gallery (search, sort, star filter and page as on
 * /browse). The page itself arrives with the first; the rest come from here.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = await requireOperator(request);
  if (denied) return denied;

  if (!isVideoExplainerEnabled())
    return jsonErrorResponse("Explainer videos are not enabled.", 404);
  const params = new URL(request.url).searchParams;
  try {
    const page = await getVideoPage({
      q: params.get("q")?.slice(0, 100),
      sort: params.get("sort"),
      page: params.get("page"),
    });
    return Response.json(page, {
      headers: {
        // New videos show up within a few minutes, like on /videos itself.
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (error) {
    logEvent("error", "video.catalog_failed", { error: errorText(error) });
    return jsonErrorResponse(
      "The videos could not be loaded. Try again soon.",
      503,
    );
  }
}

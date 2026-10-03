import { getCachedBrowsePage } from "~/server/browse-index-cache";
import { requireOperator } from "~/server/auth/require-operator";

export async function GET(request: Request) {
  const denied = await requireOperator(request);
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const result = await getCachedBrowsePage({
    q: searchParams.get("q"),
    sort: searchParams.get("sort"),
    page: searchParams.get("page"),
  });

  if (!result) {
    return Response.json(
      { error: "Browse index unavailable." },
      {
        status: 404,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }

  return Response.json(result, {
    headers: {
      "Cache-Control": "private, max-age=60",
    },
  });
}

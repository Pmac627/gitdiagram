import type { MetadataRoute } from "next";

/** A private tool: no crawler may fetch anything, and there is no sitemap. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        disallow: ["/"],
      },
    ],
  };
}

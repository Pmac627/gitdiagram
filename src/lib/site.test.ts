import { describe, expect, it } from "vitest";

import { SITE_URL } from "./site";

describe("site constants", () => {
  it("points SITE_URL at the private fork host", () => {
    expect(SITE_URL).toBe("https://gitdiagram.tuple.pro");
  });
});

import { describe, expect, it } from "vitest";

import { safeNextPath } from "./safe-next-path";

// The sign-in page and the proxy send people back to `next` after sign-in.
// Only same-origin relative paths may pass; anything else becomes "/".

describe("safeNextPath", () => {
  it.each([
    ["/", "/"],
    ["/acme/demo", "/acme/demo"],
    ["/acme/demo?utm=1&x=%2F", "/acme/demo?utm=1&x=%2F"],
    ["/videos?page=2#top", "/videos?page=2#top"],
    ["/admin", "/admin"],
  ])("keeps the relative path %s", (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });

  it.each([
    "//evil.com",
    "//evil.com/path",
    "///evil.com",
    "https://evil.com",
    "http://evil.com/x",
    "/\\evil.com",
    "\\\\evil.com",
    "\\evil.com",
    "/\\/evil.com",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<b>x</b>",
    "evil.com",
    "acme/demo",
    "",
    " ",
    "/ /evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "/acme/demo\r\nSet-Cookie: x=1",
  ])("drops %j and falls back to /", (input) => {
    expect(safeNextPath(input)).toBe("/");
  });

  it("falls back to / for a missing value", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
  });

  it("never sends people back to the sign-in page or the auth API", () => {
    expect(safeNextPath("/sign-in")).toBe("/");
    expect(safeNextPath("/sign-in?next=/admin")).toBe("/");
    expect(safeNextPath("/api/auth/session")).toBe("/");
  });

  it("drops absurdly long values", () => {
    expect(safeNextPath(`/${"a".repeat(5_000)}`)).toBe("/");
  });
});

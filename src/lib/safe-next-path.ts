/** Keep sign-in return paths on this site and out of the sign-in loop. */
export function safeNextPath(value: string | null | undefined): string {
  if (
    !value ||
    value.length > 4096 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\s\x00-\x1f\x7f]/.test(value)
  ) {
    return "/";
  }

  const path = value.split(/[?#]/, 1)[0] ?? "";

  if (
    path === "/sign-in" ||
    path === "/api/auth" ||
    path.startsWith("/api/auth/")
  ) {
    return "/";
  }

  return value;
}

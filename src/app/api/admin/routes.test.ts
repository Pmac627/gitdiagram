import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Every /admin API route: signed-out callers get 401. The only one left is the
// state read; the live switches (and their POST route) are gone.

const mocks = vi.hoisted(() => ({
  readAdminState: vi.fn(),
}));

vi.mock("~/server/admin/state", () => ({
  readAdminState: mocks.readAdminState,
}));

import { registerOperatorSession } from "~/server/auth/test-session";
import { GET as state } from "./state/route";

const session = registerOperatorSession();

afterEach(() => {
  vi.clearAllMocks();
});

describe("admin API routes", () => {
  it("state: 401 signed out", async () => {
    mocks.readAdminState.mockResolvedValue({ now: 1 });
    const read = (headers: HeadersInit = {}) =>
      state(new Request("https://gitdiagram.com/api/admin/state", { headers }));
    expect((await read()).status).toBe(401);
    expect(mocks.readAdminState).not.toHaveBeenCalled();
    const response = await read(session.headers);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ now: 1 });
  });
});

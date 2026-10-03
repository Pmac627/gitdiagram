// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  removedDependency: vi.fn(),
  registerActiveGeneration: vi.fn(),
  resolveRequestCredentials: vi.fn(),
}));

// The generation limiters were removed in Phase 3. Any call is a failure, and
// the call is recorded so a test can assert that none happened.
vi.mock("./rate-limit", () => {
  const trip = (member: string) => () => {
    mocks.removedDependency(`rate-limit.${member}`);
    throw new Error(`removed dependency called: rate-limit.${member}`);
  };

  return {
    consumeGenerationInfrastructureRateLimit: trip(
      "consumeGenerationInfrastructureRateLimit",
    ),
    consumeGenerationRateLimit: trip("consumeGenerationRateLimit"),
    getGenerationInfrastructureRateLimitMessage: trip(
      "getGenerationInfrastructureRateLimitMessage",
    ),
    getGenerationRateLimitMessage: trip("getGenerationRateLimitMessage"),
    refundGenerationInfrastructureRateLimit: trip(
      "refundGenerationInfrastructureRateLimit",
    ),
    refundGenerationRateLimit: trip("refundGenerationRateLimit"),
  };
});
vi.mock("./cancellation", () => ({
  registerActiveGeneration: mocks.registerActiveGeneration,
}));
vi.mock("~/server/http/request-credentials", () => ({
  resolveRequestCredentials: mocks.resolveRequestCredentials,
}));

import { admitGenerationRequest } from "./request-admission";

function request(body: Record<string, unknown> = {}) {
  return new Request("https://gitdiagram.com/api/generate/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "openai", repo: "openai-node", ...body }),
  });
}

describe("admitGenerationRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.registerActiveGeneration.mockResolvedValue(true);
    mocks.resolveRequestCredentials.mockImplementation(
      async (
        _request: Request,
        explicit: { apiKey?: string; githubPat?: string },
      ) => explicit,
    );
  });

  it("admits a same-origin caller with normalized request context and no limiter", async () => {
    const result = await admitGenerationRequest(request());

    expect(result).toMatchObject({
      admitted: true,
      value: {
        username: "openai",
        repo: "openai-node",
        cancellationRegistered: false,
      },
    });
    if (result.admitted) {
      expect(result.value.sessionId).toEqual(expect.any(String));
      expect(result.value).not.toHaveProperty("rateLimitedClientIp");
      expect(result.value).not.toHaveProperty("rateLimitedWindowStartSeconds");
    }
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("admits a caller using their own model key with no limiter", async () => {
    mocks.resolveRequestCredentials.mockResolvedValue({ apiKey: "sk-user" });

    const result = await admitGenerationRequest(request());

    expect(result.admitted).toBe(true);
    if (result.admitted) {
      expect(result.value.apiKey).toBe("sk-user");
    }
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("registers the requested session for cancellation", async () => {
    const result = await admitGenerationRequest(
      request({
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        cancel_token: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      }),
    );

    expect(result).toMatchObject({
      admitted: true,
      value: {
        sessionId: "550e8400-e29b-41d4-a716-446655440000",
        cancellationRegistered: true,
      },
    });
    expect(mocks.registerActiveGeneration).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    );
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("fails closed when cancellation registration is unavailable", async () => {
    mocks.registerActiveGeneration.mockRejectedValue(new Error("store down"));

    const result = await admitGenerationRequest(
      request({
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        cancel_token: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      }),
    );

    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      expect(result.response.status).toBe(503);
      await expect(result.response.json()).resolves.toMatchObject({
        error_code: "CANCELLATION_UNAVAILABLE",
      });
    }
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("rejects a session that already exists without touching a limiter", async () => {
    mocks.registerActiveGeneration.mockResolvedValue(false);

    const result = await admitGenerationRequest(
      request({
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        cancel_token: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      }),
    );

    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      expect(result.response.status).toBe(409);
      await expect(result.response.json()).resolves.toMatchObject({
        error_code: "SESSION_CONFLICT",
      });
    }
    expect(mocks.removedDependency).not.toHaveBeenCalled();
  });

  it("rejects invalid transport input before resolving credentials", async () => {
    const invalidRequest = new Request(
      "https://gitdiagram.com/api/generate/stream",
      {
        method: "POST",
        body: "{}",
      },
    );

    const result = await admitGenerationRequest(invalidRequest);

    expect(result.admitted).toBe(false);
    if (!result.admitted) {
      expect(result.response.status).toBe(415);
    }
    expect(mocks.resolveRequestCredentials).not.toHaveBeenCalled();
  });
});

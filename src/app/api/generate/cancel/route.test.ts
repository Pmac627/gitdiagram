// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  isGenerationCancelled,
  registerActiveGeneration,
} from "~/server/generate/cancellation";
import {
  createTempDataDir,
  type TempDataDir,
} from "~/server/storage/test-data-dir";

import { POST } from "~/app/api/generate/cancel/route";
import { registerOperatorSession } from "~/server/auth/test-session";

const session = registerOperatorSession();

const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const cancelToken = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function request(
  body: unknown,
  headers: HeadersInit = {},
  url = "https://gitdiagram.com/api/generate/cancel",
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://gitdiagram.com",
      "Sec-Fetch-Site": "same-origin",
      ...session.headers,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/generate/cancel", () => {
  let dataDir: TempDataDir;

  beforeEach(async () => {
    dataDir = await createTempDataDir();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await dataDir.dispose();
  });

  it("records a validated same-origin cancellation", async () => {
    await registerActiveGeneration(sessionId, cancelToken);

    const response = await POST(
      request({ session_id: sessionId, cancel_token: cancelToken }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await isGenerationCancelled(sessionId)).toBe(true);
  });

  it("ignores a cancellation carrying another session's token", async () => {
    await registerActiveGeneration(sessionId, cancelToken);

    const response = await POST(
      request({
        session_id: sessionId,
        cancel_token: "0e8e8b2c-5c1f-4f0e-9c55-0a3f6f1b7a11",
      }),
    );

    expect(response.status).toBe(204);
    expect(await isGenerationCancelled(sessionId)).toBe(false);
  });

  it("keeps an early cancellation for the session that registers afterwards", async () => {
    const response = await POST(
      request({ session_id: sessionId, cancel_token: cancelToken }),
    );

    expect(response.status).toBe(204);
    await registerActiveGeneration(sessionId, cancelToken);
    expect(await isGenerationCancelled(sessionId)).toBe(true);
  });

  it("accepts the public origin behind a trusted reverse proxy", async () => {
    const response = await POST(
      request(
        { session_id: sessionId, cancel_token: cancelToken },
        {
          Origin: "https://self-hosted.example.test",
          "X-Forwarded-Host": "self-hosted.example.test",
          "X-Forwarded-Proto": "https",
        },
        "http://0.0.0.0:8080/api/generate/cancel",
      ),
    );

    expect(response.status).toBe(204);
  });

  it("rejects cross-origin, malformed, and non-strict payloads", async () => {
    const crossOriginResponse = await POST(
      request(
        { session_id: sessionId, cancel_token: cancelToken },
        {
          Origin: "https://attacker.example",
          "Sec-Fetch-Site": "cross-site",
        },
      ),
    );
    expect(crossOriginResponse.status).toBe(403);
    await expect(crossOriginResponse.json()).resolves.toEqual({
      ok: false,
      error: "Cross-origin cancellation is not allowed.",
    });
    await expect(
      POST(request({ session_id: "not-a-uuid", cancel_token: cancelToken })),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      POST(
        request({
          session_id: sessionId,
          cancel_token: cancelToken,
          extra: true,
        }),
      ),
    ).resolves.toMatchObject({ status: 400 });
    // The operator check fails closed before payload validation when its
    // session store cannot be read.
    delete process.env.DATA_DIR;
    await expect(
      POST(request({ session_id: "not-a-uuid", cancel_token: cancelToken })),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("rejects the session when the cancellation store is unavailable", async () => {
    // No DATA_DIR: the database cannot open.
    delete process.env.DATA_DIR;

    const response = await POST(
      request({ session_id: sessionId, cancel_token: cancelToken }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Sign in as the operator.",
    });
  });
});

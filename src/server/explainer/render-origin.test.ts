import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import * as renderOrigin from "./render-origin";

const { internalOrigin } = renderOrigin;

const originalEnv = { ...process.env };
const request = (url: string) => new Request(url);

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("render self-calls", () => {
  it("no longer offers deployment pinning", () => {
    expect(Object.keys(renderOrigin)).not.toContain("deploymentHeaders");
    expect(Object.keys(renderOrigin)).not.toContain("pinToDeployment");
  });

  it("uses loopback on the server's own port in production, even when VERCEL is set", () => {
    Object.assign(process.env, { NODE_ENV: "production", PORT: "8080" });
    delete process.env.VIDEO_INTERNAL_ORIGIN;
    process.env.VERCEL = "1";
    expect(internalOrigin(request("https://example.com/api/x"))).toBe(
      "http://127.0.0.1:8080",
    );
    delete process.env.VERCEL;
    expect(internalOrigin(request("http://0.0.0.0:8080/api/x"))).toBe(
      "http://127.0.0.1:8080",
    );
  });

  it("trims whitespace around PORT", () => {
    Object.assign(process.env, { NODE_ENV: "production", PORT: " 8080 " });
    delete process.env.VIDEO_INTERNAL_ORIGIN;
    expect(internalOrigin(request("http://0.0.0.0:8080/api/x"))).toBe(
      "http://127.0.0.1:8080",
    );
  });

  it("falls back to the request's origin in production when PORT is empty", () => {
    Object.assign(process.env, { NODE_ENV: "production", PORT: "   " });
    delete process.env.VIDEO_INTERNAL_ORIGIN;
    expect(internalOrigin(request("https://host.example/api/x"))).toBe(
      "https://host.example",
    );
  });

  it("lets VIDEO_INTERNAL_ORIGIN win, keeping only its origin", () => {
    Object.assign(process.env, { NODE_ENV: "production", PORT: "8080" });
    process.env.VIDEO_INTERNAL_ORIGIN = "http://render.internal:9000/path";
    expect(internalOrigin(request("http://0.0.0.0:8080/api/x"))).toBe(
      "http://render.internal:9000",
    );
  });

  it("use the request's origin in development", () => {
    Object.assign(process.env, { NODE_ENV: "development", PORT: "3000" });
    delete process.env.VERCEL;
    delete process.env.VIDEO_INTERNAL_ORIGIN;
    expect(internalOrigin(request("http://localhost:3000/api/x"))).toBe(
      "http://localhost:3000",
    );
  });
});

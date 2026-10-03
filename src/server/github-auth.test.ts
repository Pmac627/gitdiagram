// @vitest-environment node
import { generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getGitHubApiHeaders, readGitHubPatPool } from "~/server/github-auth";

const originalGithubPat = process.env.GITHUB_PAT;
const originalGithubPats = process.env.GITHUB_PATS;

afterEach(() => {
  if (originalGithubPat === undefined) delete process.env.GITHUB_PAT;
  else process.env.GITHUB_PAT = originalGithubPat;
  if (originalGithubPats === undefined) delete process.env.GITHUB_PATS;
  else process.env.GITHUB_PATS = originalGithubPats;
});

describe("readGitHubPatPool", () => {
  it("uses a standalone GITHUB_PAT and deduplicates pooled tokens", () => {
    process.env.GITHUB_PAT = "single";
    process.env.GITHUB_PATS = "pooled, single\npooled";

    expect(readGitHubPatPool()).toEqual(["pooled", "single"]);
  });

  it("does not drop GITHUB_PAT when GITHUB_PATS is unset", () => {
    process.env.GITHUB_PAT = "single";
    delete process.env.GITHUB_PATS;

    expect(readGitHubPatPool()).toEqual(["single"]);
  });

  it("round-robins the fallback PAT pool", async () => {
    delete process.env.GITHUB_PAT;
    process.env.GITHUB_PATS = "first,second";

    const headers = await Promise.all([
      getGitHubApiHeaders({ allowGitHubAppAuth: false }),
      getGitHubApiHeaders({ allowGitHubAppAuth: false }),
      getGitHubApiHeaders({ allowGitHubAppAuth: false }),
    ]);

    expect(headers.map((value) => value.Authorization)).toEqual([
      "Bearer first",
      "Bearer second",
      "Bearer first",
    ]);
  });

  it("keeps an explicit request PAT ahead of the fallback pool", async () => {
    process.env.GITHUB_PATS = "fallback";

    await expect(
      getGitHubApiHeaders({
        githubPat: "request-token",
        allowGitHubAppAuth: false,
      }),
    ).resolves.toMatchObject({
      Authorization: "Bearer request-token",
    });
  });
});

describe("installation token failure logging", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("scrubs the app JWT, tokens and env keys from the logged body", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const envKey = "env-openai-key-0002-plain";
    const ghToken = `ghs_${"a1B2c3D4e5".repeat(4)}`;
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    vi.stubEnv(
      "GITHUB_PRIVATE_KEY",
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    vi.stubEnv("GITHUB_APP_ID", "12345");
    vi.stubEnv("GITHUB_INSTALLATION_ID", "67890");
    vi.stubEnv("OPENAI_API_KEY", envKey);
    vi.stubEnv("GITHUB_PAT", "");
    vi.stubEnv("GITHUB_PATS", "");

    let sentAuthorization = "";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentAuthorization = String(
          (init.headers as Record<string, string>).Authorization,
        );

        return new Response(
          JSON.stringify({
            message: `Bad credentials for ${ghToken} and ${envKey}. Echo: Authorization: ${sentAuthorization}`,
          }),
          { status: 401 },
        );
      }),
    );

    await expect(getGitHubApiHeaders()).rejects.toThrow(
      "Failed to create GitHub App installation token (401). Please retry.",
    );

    const jwt = sentAuthorization.replace(/^Bearer /, "");
    const logged = errorSpy.mock.calls.flat().join(" ");

    expect(jwt.split(".")).toHaveLength(3);
    expect(logged).toContain("github_auth.installation_token_failed");
    expect(logged).toContain("Bad credentials");
    expect(logged).not.toContain(jwt);
    // The 500-character cap cuts the JWT, so a leak would be its first part.
    expect(logged).not.toContain(jwt.split(".")[0]!);
    expect(logged).not.toContain(ghToken);
    expect(logged).not.toContain(envKey);
  });
});

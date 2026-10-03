// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { errorText, redactLogText } from "~/server/log";

const GITHUB_TOKEN = `ghp_${"a1B2c3D4e5".repeat(4)}`;
const OPENAI_KEY = "sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12Mn34";
// Shapes no pattern recognizes, so only the known-secret path can catch them.
const PLAIN_KEY = "caller-key-3f9a7c21d8e5";
const MASKED_SUFFIX_KEY = "lm-studio-token-Zq81xPv3";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("redactLogText: pattern-based redaction", () => {
  it("removes provider keys and GitHub tokens but keeps the message readable", () => {
    const text = `401 Unauthorized: bad key ${OPENAI_KEY} and token ${GITHUB_TOKEN} for org acme.`;

    const result = redactLogText(text);

    expect(result).not.toContain(OPENAI_KEY);
    expect(result).not.toContain(GITHUB_TOKEN);
    expect(result).toContain("401 Unauthorized");
    expect(result).toContain("for org acme.");
  });

  it("strips a Bearer token whatever its shape", () => {
    const result = redactLogText(
      "request failed, sent Bearer abc123DEF456ghi789jkl then stopped",
    );

    expect(result).not.toContain("abc123DEF456ghi789jkl");
    expect(result).toContain("request failed");
    expect(result).toContain("then stopped");
  });

  it("strips the value of an Authorization header, Basic included", () => {
    const basic = redactLogText(
      "echo Authorization: Basic dXNlcjpwYXNzd29yZA==",
    );
    const bearer = redactLogText(
      '{"headers":{"Authorization":"Bearer zzTop99"}}',
    );

    expect(basic).not.toContain("dXNlcjpwYXNzd29yZA==");
    expect(bearer).not.toContain("zzTop99");
  });

  it("leaves ordinary error text unchanged", () => {
    for (const text of [
      "rate limit exceeded",
      "Not Found",
      "Repository not found.",
      "GitHub request failed (409). Please retry.",
      "connect ECONNREFUSED 127.0.0.1:1234",
      "Unexpected token < in JSON at position 0",
    ]) {
      expect(redactLogText(text)).toBe(text);
    }
  });

  it("returns an empty string for empty input", () => {
    expect(redactLogText("")).toBe("");
  });

  it("is idempotent", () => {
    const text = `bad ${OPENAI_KEY} Authorization: Bearer abc123DEF456 and ${PLAIN_KEY}`;

    const once = redactLogText(text, [PLAIN_KEY]);

    expect(redactLogText(once, [PLAIN_KEY])).toBe(once);
  });
});

describe("redactLogText: known secrets", () => {
  it("replaces every exact occurrence of a known secret", () => {
    const result = redactLogText(
      `key ${PLAIN_KEY} was rejected; retried with ${PLAIN_KEY}`,
      [PLAIN_KEY],
    );

    expect(result).not.toContain(PLAIN_KEY);
    expect(result).toContain("was rejected");
    expect(result).toContain("[REDACTED");
  });

  it("replaces the visible suffix when an upstream echoes the key partly masked", () => {
    const result = redactLogText(
      "Incorrect API key provided: lm-s**************xPv3. Find your key in settings.",
      [MASKED_SUFFIX_KEY],
    );

    expect(result).not.toContain("xPv3");
    expect(result).toContain("Incorrect API key provided");
    expect(result).toContain("Find your key in settings.");
  });

  it("replaces the suffix of a masked OpenAI-style key with an ellipsis mask", () => {
    const result = redactLogText(
      "Incorrect API key provided: sk-proj-...Zq81xPv3.",
      [MASKED_SUFFIX_KEY],
    );

    expect(result).not.toContain("xPv3");
  });

  it("does not treat a short coincidence as a masked key", () => {
    const text = "Not Found: the endpoint does not exist";

    expect(redactLogText(text, [MASKED_SUFFIX_KEY])).toBe(text);
  });

  it("ignores empty, whitespace and missing known secrets", () => {
    const text = "rate limit exceeded for this organization";

    expect(redactLogText(text, ["", "   ", undefined])).toBe(text);
  });

  it("redacts secrets read from the environment without being told", () => {
    const env: Record<string, string> = {
      AI_API_KEY: "env-ai-key-0001-plain",
      OPENAI_API_KEY: "env-openai-key-0002-plain",
      ANTHROPIC_API_KEY: "env-anthropic-key-0003-plain",
      OPENROUTER_API_KEY: "env-openrouter-key-0004-plain",
      GITHUB_PAT: "env-github-pat-0005-plain",
      GITHUB_PATS: "env-pool-one-0006-plain,env-pool-two-0007-plain",
      CACHE_KEY_SECRET: "env-cache-secret-0008-plain",
      OPERATOR_TOKEN: "env-operator-token-0009-plain",
    };

    for (const [name, value] of Object.entries(env)) {
      vi.stubEnv(name, value);
    }

    const result = redactLogText(
      `upstream said: ${Object.values(env).join(" | ")} end`,
    );

    for (const value of [
      ...Object.values(env).filter((value) => !value.includes(",")),
      "env-pool-one-0006-plain",
      "env-pool-two-0007-plain",
    ]) {
      expect(result).not.toContain(value);
    }

    expect(result).toContain("upstream said:");
    expect(result).toContain("end");
  });

  it("does not replace everything when an env secret is unset or empty", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("CACHE_KEY_SECRET", "   ");

    expect(redactLogText("Not Found")).toBe("Not Found");
  });
});

describe("redactLogText: bounds", () => {
  it("never returns more than the cap and defaults the cap to 500", () => {
    const result = redactLogText("e".repeat(2_000));

    expect(result.length).toBeLessThanOrEqual(500);
    expect(
      redactLogText("e".repeat(2_000), [], 120).length,
    ).toBeLessThanOrEqual(120);
  });

  it("redacts before it truncates, so a key cut by the cap cannot leak a piece", () => {
    const text = `${"x".repeat(495)}${GITHUB_TOKEN}`;

    const result = redactLogText(text);

    expect(result).not.toContain(GITHUB_TOKEN.slice(0, 4));
  });

  it("redacts a known key that straddles the cap", () => {
    const text = `${"x".repeat(495)}${PLAIN_KEY}`;

    const result = redactLogText(text, [PLAIN_KEY]);

    expect(result).not.toContain(PLAIN_KEY.slice(0, 5));
  });
});

describe("errorText", () => {
  it("redacts keys in an error message and keeps the rest", () => {
    const result = errorText(new Error(`Bad key ${OPENAI_KEY} on retry`));

    expect(result).not.toContain(OPENAI_KEY);
    expect(result).toContain("Bad key");
  });

  it("redacts secrets from the environment", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "env-openrouter-key-0004-plain");

    expect(
      errorText(new Error("402 for env-openrouter-key-0004-plain")),
    ).not.toContain("env-openrouter-key-0004-plain");
  });

  it("keeps the 200-character cap and redacts before cutting", () => {
    const error = new Error(`${"y".repeat(195)}${GITHUB_TOKEN}`);
    const result = errorText(error);

    expect(result.length).toBeLessThanOrEqual(200);
    expect(result).not.toContain(GITHUB_TOKEN.slice(0, 4));
  });

  it("still answers unknown for a non-error", () => {
    expect(errorText("boom")).toBe("unknown");
  });
});

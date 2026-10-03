import { describe, expect, it } from "vitest";
import { redactSecrets, totalFindings } from "./secret-scan";

// Secret-shaped fixtures are assembled at run time so this file itself never
// contains a literal that a repository scanner would flag.
const join = (...parts: string[]) => parts.join("");
const b64url = (value: string) => Buffer.from(value).toString("base64url");

const AWS_KEY = join("AKIA", "IOSFODNN7EXAMPLE");
const AWS_SESSION_KEY = join("ASIA", "Y34FZKBOKMUTVV7A");
const GITHUB_PAT = join("ghp_", "16C7e42F292c6912E7710c838347Ae178B4a");
const GITHUB_OAUTH = join("gho_", "16C7e42F292c6912E7710c838347Ae178B4a");
const GITHUB_FINE = join(
  "github_pat_",
  "11ABCDEFG0aBcDeFgHiJkL_",
  "Q9z8Y7w6V5u4T3s2R1p0Zx81QmN4vB7tLk20WdRyHc93",
);
const OPENAI_KEY = join("sk-", "proj-Zx81QmN4vB7tLk20WdRyHc93FgJaPe56");
const ANTHROPIC_KEY = join(
  "sk-ant-",
  "api03-Zx81QmN4vB7tLk20WdRyHc93FgJaPe56Uu",
);
const XAI_KEY = join("xai-", "Zx81QmN4vB7tLk20WdRyHc93FgJaPe56UuVv12Ww");
const GOOGLE_KEY = join("AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q");
const SLACK_TOKEN = join(
  "xoxb-",
  "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx",
);
const STRIPE_LIVE = join("sk_live_", "51HqZx81QmN4vB7tLk20WdRy");
const STRIPE_RESTRICTED = join("rk_live_", "51HqZx81QmN4vB7tLk20WdRy");
const JWT = join(
  b64url('{"alg":"HS256","typ":"JWT"}'),
  ".",
  b64url('{"sub":"1234567890","name":"Ada Lovelace","iat":1516239022}'),
  ".",
  b64url("signature-bytes-0123456789abcdef"),
);
const PRIVATE_KEY_BODY = [
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj",
  "MzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu",
].join("\n");
const PRIVATE_KEY_BLOCK = `-----BEGIN PRIVATE KEY-----\n${PRIVATE_KEY_BODY}\n-----END PRIVATE KEY-----`;

describe("redactSecrets detection", () => {
  it("returns clean text untouched with an empty findings map", () => {
    const text = "export const main = () => 1;\n// nothing to see\n";

    const result = redactSecrets(text);

    expect(result.text).toBe(text);
    expect(result.findings).toEqual({});
    expect(totalFindings(result.findings)).toBe(0);
  });

  it("handles the empty string", () => {
    expect(redactSecrets("")).toEqual({ text: "", findings: {} });
  });

  it.each([
    ["aws-access-key", AWS_KEY],
    ["aws-access-key", AWS_SESSION_KEY],
    ["github-token", GITHUB_PAT],
    ["github-token", GITHUB_OAUTH],
    ["github-token", GITHUB_FINE],
    ["openai-key", OPENAI_KEY],
    ["anthropic-key", ANTHROPIC_KEY],
    ["xai-key", XAI_KEY],
    ["google-api-key", GOOGLE_KEY],
    ["slack-token", SLACK_TOKEN],
    ["stripe-key", STRIPE_LIVE],
    ["stripe-key", STRIPE_RESTRICTED],
    ["jwt", JWT],
  ])("redacts a %s and never returns the value", (kind, secret) => {
    const text = `const client = connect("${secret}");\nrun(client);\n`;

    const result = redactSecrets(text);

    expect(result.text).not.toContain(secret);
    expect(result.text).toContain(`[REDACTED:${kind}]`);
    expect(result.text).toContain("const client = connect(");
    expect(result.text).toContain("run(client);");
    expect(result.findings).toEqual({ [kind]: 1 });
    expect(JSON.stringify(result.findings)).not.toContain(secret);
  });

  it("redacts a whole private key block and keeps the line count", () => {
    const text = `const a = 1;\n${PRIVATE_KEY_BLOCK}\nconst b = 2;\n`;

    const result = redactSecrets(text);

    expect(result.text).not.toContain("BEGIN PRIVATE KEY");
    expect(result.text).not.toContain("END PRIVATE KEY");
    for (const line of PRIVATE_KEY_BODY.split("\n")) {
      expect(result.text).not.toContain(line);
    }
    expect(result.text).toContain("[REDACTED:private-key]");
    expect(result.text.startsWith("const a = 1;\n")).toBe(true);
    expect(result.text.endsWith("const b = 2;\n")).toBe(true);
    expect(result.text.split("\n")).toHaveLength(text.split("\n").length);
    expect(result.findings).toEqual({ "private-key": 1 });
  });

  it.each([
    "RSA PRIVATE KEY",
    "EC PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
    "ENCRYPTED PRIVATE KEY",
  ])("redacts a %s block", (label) => {
    const text = `-----BEGIN ${label}-----\n${PRIVATE_KEY_BODY}\n-----END ${label}-----\n`;

    const result = redactSecrets(text);

    expect(result.text).not.toContain(PRIVATE_KEY_BODY.split("\n")[0]!);
    expect(result.findings).toEqual({ "private-key": 1 });
  });

  it("redacts from an unterminated private key header to the end of the text", () => {
    const text = `const a = 1;\n-----BEGIN PRIVATE KEY-----\n${PRIVATE_KEY_BODY}\n`;

    const result = redactSecrets(text);

    expect(result.text).not.toContain(PRIVATE_KEY_BODY.split("\n")[0]!);
    expect(result.text).toContain("const a = 1;");
    expect(result.findings).toEqual({ "private-key": 1 });
  });

  it("does not redact a public key block", () => {
    const text = `-----BEGIN PUBLIC KEY-----\n${PRIVATE_KEY_BODY}\n-----END PUBLIC KEY-----\n`;

    expect(redactSecrets(text)).toEqual({ text, findings: {} });
  });

  it("redacts only the password of a connection string", () => {
    const text =
      'const url = "postgres://admin:s3cr3tPassw0rd!@db.internal:5432/app";';

    const result = redactSecrets(text);

    expect(result.text).not.toContain("s3cr3tPassw0rd");
    expect(result.text).toContain("postgres://admin:");
    expect(result.text).toContain("@db.internal:5432/app");
    expect(result.text).toContain("[REDACTED:connection-string]");
    expect(result.findings).toEqual({ "connection-string": 1 });
  });

  it.each([
    'const password = "Zx81QmN4vB7tLk20WdRy";',
    "const apiKey = 'Zx81QmN4vB7tLk20WdRy';",
    'api_key = "Zx81QmN4vB7tLk20WdRy"',
    '"client_secret": "Zx81QmN4vB7tLk20WdRy",',
    "SECRET_TOKEN=Zx81QmN4vB7tLk20WdRy",
    "db.passwd: 'Zx81QmN4vB7tLk20WdRy'",
    'clientSecret: "Zx81QmN4vB7tLk20WdRy"',
  ])("redacts the value of a high-entropy assignment: %s", (line) => {
    const result = redactSecrets(`${line}\nnext();\n`);

    expect(result.text).not.toContain("Zx81QmN4vB7tLk20WdRy");
    expect(result.text).toContain("[REDACTED:generic-secret]");
    expect(result.text).toContain("next();");
    expect(result.findings).toEqual({ "generic-secret": 1 });
  });

  it("keeps the assignment shape around a generic secret", () => {
    const result = redactSecrets('const apiKey = "Zx81QmN4vB7tLk20WdRy";');

    expect(result.text).toBe('const apiKey = "[REDACTED:generic-secret]";');
  });

  it("counts every finding by kind", () => {
    const text = [
      `a = "${AWS_KEY}"`,
      `b = "${AWS_SESSION_KEY}"`,
      `c = "${GITHUB_PAT}"`,
      PRIVATE_KEY_BLOCK,
    ].join("\n");

    const result = redactSecrets(text);

    expect(result.findings).toEqual({
      "aws-access-key": 2,
      "github-token": 1,
      "private-key": 1,
    });
    expect(totalFindings(result.findings)).toBe(4);
  });

  it("is idempotent: redacted text has no further findings", () => {
    const once = redactSecrets(`k = "${OPENAI_KEY}"\n${PRIVATE_KEY_BLOCK}\n`);
    const twice = redactSecrets(once.text);

    expect(twice.text).toBe(once.text);
    expect(twice.findings).toEqual({});
  });
});

describe("redactSecrets false positives", () => {
  it.each([
    "const token = getToken();",
    "password: string;",
    "const secret = process.env.SECRET;",
    "let apiKey: string | undefined = undefined;",
    'const apiKey = "";',
    'password = "changeme"',
    'const token = "your-api-key-here";',
    'api_key = "xxxxxxxxxxxxxxxxxxxx"',
    'secret: "aaaaaaaaaaaaaaaaaaaaaaaa"',
    'const password = "${DB_PASSWORD}";',
    'const token = "{{ .Values.token }}";',
    'SECRET_TOKEN="$SECRET_TOKEN_FROM_VAULT"',
    "password = os.environ['DB_PASSWORD']",
    "maxTokens: 4096,",
    'const maxTokens = "1048576000";',
    'const tokenizer = "cl100k_base_encoding_v1";',
    "const secretsManager = new SecretsManager();",
    'label = "Enter your password here"',
    "token = tokens.next().value;",
  ])("leaves ordinary code alone: %s", (line) => {
    const result = redactSecrets(`${line}\n`);

    expect(result.text).toBe(`${line}\n`);
    expect(result.findings).toEqual({});
  });

  it("leaves lockfile integrity hashes and commit SHAs alone", () => {
    const text = [
      '  "left-pad@1.3.0": ["left-pad@1.3.0", "", {}, "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA=="],',
      '  "integrity": "sha1-0123456789abcdef0123456789abcdef01234567",',
      "  resolved: 0123456789abcdef0123456789abcdef01234567",
      "  sha: 9fceb02d0ae598e95dc970b74767f19372d61af8",
    ].join("\n");

    expect(redactSecrets(text)).toEqual({ text, findings: {} });
  });

  it("leaves placeholder and local connection strings alone", () => {
    const text = [
      'const a = "postgres://user:${DB_PASSWORD}@db:5432/app";',
      'const b = "http://localhost:3000/path";',
      'const c = "https://example.com:8443/a";',
      'const d = "postgres://user:password@localhost/app";',
      'const e = "redis://:@cache:6379";',
    ].join("\n");

    expect(redactSecrets(text)).toEqual({ text, findings: {} });
  });

  it("leaves short look-alike prefixes alone", () => {
    const text = [
      'const skill = "sk-learn";',
      "// ghp_ is the prefix GitHub uses",
      'const t = "AKIA";',
      'const x = "xai-";',
      "sk_live_ keys start with this",
      'const a = "eyJhbGciOi";',
    ].join("\n");

    expect(redactSecrets(text)).toEqual({ text, findings: {} });
  });
});

describe("redactSecrets performance", () => {
  const BOUND_MS = 250;
  const time = (text: string) => {
    const start = performance.now();
    const result = redactSecrets(text);

    return { result, elapsed: performance.now() - start };
  };

  it("scans the 48k excerpt budget and a large README quickly", () => {
    const code = "const value = compute(input, options);\n".repeat(1_400);
    const readme = "# Title\n\nSome prose about the project. ".repeat(10_000);

    expect(time(code.slice(0, 48_000)).elapsed).toBeLessThan(BOUND_MS);
    expect(time(readme).elapsed).toBeLessThan(BOUND_MS * 2);
  });

  it.each([
    ["a run of a", "a".repeat(200_000)],
    ["a run of =", "=".repeat(200_000)],
    ["a run of quotes", '"'.repeat(200_000)],
    [
      "name then equals and quotes",
      `password${"=".repeat(50_000)}${'"'.repeat(50_000)}`,
    ],
    ["repeated assignment openers", 'secret = "'.repeat(20_000)],
    [
      "repeated unterminated key headers",
      "-----BEGIN PRIVATE KEY-----\n".repeat(5_000),
    ],
    ["repeated scheme openers", "postgres://a:".repeat(20_000)],
    ["jwt-like dots", "eyJ" + "a.".repeat(100_000)],
    ["long token prefix", "sk-" + "a".repeat(200_000)],
  ])("does not backtrack catastrophically on %s", (_name, text) => {
    const { elapsed } = time(text);

    expect(elapsed).toBeLessThan(BOUND_MS * 4);
  });
});

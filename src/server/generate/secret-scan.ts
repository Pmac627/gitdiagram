/**
 * The kinds of secret the scanner recognizes. The kind is the only thing a
 * caller ever learns about a match, never the matched value.
 */
type SecretKind =
  | "private-key"
  | "aws-access-key"
  | "github-token"
  | "openai-key"
  | "anthropic-key"
  | "xai-key"
  | "google-api-key"
  | "slack-token"
  | "stripe-key"
  | "jwt"
  | "connection-string"
  | "generic-secret";

/** Number of redactions per kind. A kind with no match is absent. */
export type SecretFindings = Partial<Record<SecretKind, number>>;

/** The redacted text and the per-kind counts. It never carries the values. */
export interface SecretScanResult {
  text: string;
  findings: SecretFindings;
}

// Every pattern below starts at a literal prefix or a lookbehind and uses
// bounded quantifiers, so no input can make the scan superlinear.
const PRIVATE_KEY_HEADER =
  /-----BEGIN (?:[A-Z0-9]{1,20} ){0,3}PRIVATE KEY-----/g;
const PRIVATE_KEY_FOOTER = /-----END (?:[A-Z0-9]{1,20} ){0,3}PRIVATE KEY-----/g;

const NOT_WORD_BEFORE = "(?<![A-Za-z0-9_-])";

const TOKEN_RULES: ReadonlyArray<{
  kind: SecretKind;
  pattern: RegExp;
  accept?: (match: string) => boolean;
}> = [
  {
    kind: "aws-access-key",
    pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
  },
  {
    kind: "github-token",
    pattern: new RegExp(
      `${NOT_WORD_BEFORE}(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})`,
      "g",
    ),
  },
  {
    kind: "anthropic-key",
    pattern: new RegExp(`${NOT_WORD_BEFORE}sk-ant-[A-Za-z0-9_-]{20,200}`, "g"),
  },
  {
    kind: "openai-key",
    pattern: new RegExp(
      `${NOT_WORD_BEFORE}sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,200}`,
      "g",
    ),
    // Kebab-case words such as "sk-some-long-identifier" have no digit.
    accept: (match) => /\d/.test(match),
  },
  {
    kind: "xai-key",
    pattern: new RegExp(`${NOT_WORD_BEFORE}xai-[A-Za-z0-9]{30,128}`, "g"),
    accept: (match) => /\d/.test(match),
  },
  {
    kind: "google-api-key",
    pattern: new RegExp(`${NOT_WORD_BEFORE}AIza[0-9A-Za-z_-]{35}`, "g"),
  },
  {
    kind: "slack-token",
    pattern: new RegExp(
      `${NOT_WORD_BEFORE}xox[abprs]-[A-Za-z0-9-]{10,200}`,
      "g",
    ),
  },
  {
    kind: "stripe-key",
    pattern: new RegExp(`${NOT_WORD_BEFORE}[sr]k_live_[A-Za-z0-9]{16,99}`, "g"),
  },
  {
    kind: "jwt",
    pattern: new RegExp(
      `${NOT_WORD_BEFORE}eyJ[A-Za-z0-9_-]{8,2000}\\.eyJ[A-Za-z0-9_-]{8,2000}\\.[A-Za-z0-9_-]{8,2000}`,
      "g",
    ),
  },
];

const CONNECTION_STRING =
  /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/'"]{0,100}:)([^\s@/'"]{1,200})(@)/gi;

const GENERIC_ASSIGNMENT =
  /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,64})(["']?\s{0,4}[:=]\s{0,4}["'`]?)([A-Za-z0-9_+/~!@#%^&*-][A-Za-z0-9_+/=.~!@#%^&*-]{15,199})(?=[\s"'`,;)}\]]|$)/g;

const SECRET_WORDS = new Set([
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "credential",
  "credentials",
]);

// Word pairs that name a secret only together, such as "api_key".
const SECRET_PAIRS = new Set([
  "api key",
  "private key",
  "access key",
  "secret key",
  "auth key",
  "signing key",
  "encryption key",
]);

const PLACEHOLDER =
  /(?:your|example|changeme|change-me|placeholder|dummy|sample|insert|replace|redacted|todo|fixme|xxxx|\*\*\*\*)/i;

const DOTTED_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

const MIN_ENTROPY_BITS_PER_CHAR = 3.5;

function mark(kind: SecretKind): string {
  return `[REDACTED:${kind}]`;
}

function count(findings: SecretFindings, kind: SecretKind, amount = 1): void {
  findings[kind] = (findings[kind] ?? 0) + amount;
}

function countNewlines(text: string): number {
  let newlines = 0;

  for (let index = text.indexOf("\n"); index !== -1;) {
    newlines += 1;
    index = text.indexOf("\n", index + 1);
  }

  return newlines;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();

  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }

  let entropy = 0;

  for (const occurrences of counts.values()) {
    const probability = occurrences / value.length;
    entropy -= probability * Math.log2(probability);
  }

  return entropy;
}

function namesASecret(identifier: string): boolean {
  const words = identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  for (let index = 0; index < words.length; index += 1) {
    if (SECRET_WORDS.has(words[index]!)) {
      return true;
    }

    if (
      index + 1 < words.length &&
      SECRET_PAIRS.has(`${words[index]} ${words[index + 1]}`)
    ) {
      return true;
    }
  }

  return false;
}

function looksLikeSecretValue(value: string): boolean {
  if (value.length < 16 || !/\d/.test(value) || !/[A-Za-z]/.test(value)) {
    return false;
  }

  if (PLACEHOLDER.test(value) || DOTTED_PATH.test(value)) {
    return false;
  }

  return shannonEntropy(value) >= MIN_ENTROPY_BITS_PER_CHAR;
}

function looksLikeRealPassword(password: string): boolean {
  if (/^[$[{<%]/.test(password)) {
    return false;
  }

  return !/^(?:password|passwd|pass|pwd|secret|changeme|example|your.*|x+|\*+)$/i.test(
    password,
  );
}

function redactPrivateKeys(text: string, findings: SecretFindings): string {
  PRIVATE_KEY_HEADER.lastIndex = 0;

  let output = "";
  let cursor = 0;

  for (;;) {
    const header = PRIVATE_KEY_HEADER.exec(text);

    if (!header) {
      break;
    }

    PRIVATE_KEY_FOOTER.lastIndex = header.index + header[0].length;

    const footer = PRIVATE_KEY_FOOTER.exec(text);
    // An unterminated block is redacted to the end: the rest may be the key.
    const end = footer ? footer.index + footer[0].length : text.length;
    const block = text.slice(header.index, end);

    output += text.slice(cursor, header.index);
    output += mark("private-key") + "\n".repeat(countNewlines(block));
    cursor = end;
    count(findings, "private-key");
    PRIVATE_KEY_HEADER.lastIndex = end;
  }

  return cursor === 0 ? text : output + text.slice(cursor);
}

/**
 * Replaces secrets in `text` with `[REDACTED:<kind>]` markers and counts them
 * per kind. The scan is linear in the input size, never returns a matched
 * value, and is idempotent: redacted text scans clean.
 *
 * Detection covers private key blocks, well-known provider key and token
 * formats, JWTs, the password of a connection string, and the value of a
 * name-anchored, high-entropy assignment. Test keys (`sk_test_`) are left.
 *
 * @see docs/flows/diagram-generation.md
 */
export function redactSecrets(text: string): SecretScanResult {
  if (typeof text !== "string") {
    throw new TypeError("redactSecrets expects a string.");
  }

  if (text.length === 0) {
    return { text, findings: {} };
  }

  const findings: SecretFindings = {};
  let result = redactPrivateKeys(text, findings);

  for (const rule of TOKEN_RULES) {
    result = result.replace(rule.pattern, (match) => {
      if (rule.accept && !rule.accept(match)) {
        return match;
      }

      count(findings, rule.kind);

      return mark(rule.kind);
    });
  }

  result = result.replace(
    CONNECTION_STRING,
    (match, prefix: string, password: string, at: string) => {
      if (!looksLikeRealPassword(password)) {
        return match;
      }

      count(findings, "connection-string");

      return `${prefix}${mark("connection-string")}${at}`;
    },
  );

  result = result.replace(
    GENERIC_ASSIGNMENT,
    (match, name: string, separator: string, value: string) => {
      if (!namesASecret(name) || !looksLikeSecretValue(value)) {
        return match;
      }

      count(findings, "generic-secret");

      return `${name}${separator}${mark("generic-secret")}`;
    },
  );

  return { text: result, findings };
}

/**
 * Sums the per-kind counts of a scan.
 *
 * @see docs/flows/diagram-generation.md
 */
export function totalFindings(findings: SecretFindings): number {
  let total = 0;

  for (const amount of Object.values(findings)) {
    total += amount ?? 0;
  }

  return total;
}

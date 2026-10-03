import "server-only";
import { redactSecrets } from "~/server/generate/secret-scan";

const DEFAULT_LOG_TEXT_MAX = 500;
const ERROR_TEXT_MAX = 200;

/** A secret shorter than this is skipped: replacing it would shred the text. */
const MIN_KNOWN_SECRET_LENGTH = 6;

/** Only the last characters of a masked key are visible; this many or more. */
const MIN_MASKED_SUFFIX_LENGTH = 4;

const ENV_SECRET_NAMES = [
  "AI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "GITHUB_PAT",
  "CACHE_KEY_SECRET",
  "OPERATOR_TOKEN",
] as const;

// A mask run (asterisks, dots or bullets) followed by the visible tail of a
// key. The lookbehind anchors the match at the start of the run, so a long run
// of mask characters cannot make the scan superlinear.
const MASKED_TAIL =
  /(?<![*.…•])(?:\*{3,}|\.{3,}|…|•{3,})([A-Za-z0-9_-]{4,200})/g;

// The scanner needs a word boundary before a GitHub token. A log line may run
// a token straight onto other text, so this pattern has no such boundary.
const GITHUB_TOKEN_ANYWHERE =
  /(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})/g;

const BEARER_TOKEN = /\bBearer\s{1,20}[A-Za-z0-9._~+/=-]{1,2000}/gi;

const AUTHORIZATION_VALUE =
  /(\bauthorization["']?\s{0,4}[:=]\s{0,4}["']?)(?:[A-Za-z]{2,20}\s{1,4})?[^\s"',}]{1,2000}/gi;

function envSecrets(): string[] {
  const values: string[] = [];

  for (const name of ENV_SECRET_NAMES) {
    values.push(process.env[name] ?? "");
  }

  // The token pool is a comma or newline separated list.
  values.push(...(process.env.GITHUB_PATS ?? "").split(/[,\r\n]+/));

  return values;
}

function normalizeSecrets(
  knownSecrets: ReadonlyArray<string | null | undefined>,
): string[] {
  const unique = new Set<string>();

  for (const secret of [...knownSecrets, ...envSecrets()]) {
    const trimmed = typeof secret === "string" ? secret.trim() : "";

    if (trimmed.length >= MIN_KNOWN_SECRET_LENGTH) {
      unique.add(trimmed);
    }
  }

  // Longest first, so a secret that contains another is replaced whole.
  return [...unique].sort((left, right) => right.length - left.length);
}

/**
 * Scrubs secrets from text before it reaches a log line or an error message.
 *
 * Order: exact occurrences of known secrets (the ones passed in and the
 * server's own keys from the environment), the visible tail of a key that an
 * upstream echoed partly masked, the well-known key and token patterns of
 * `redactSecrets`, then `Bearer` tokens and `Authorization` header values.
 * Redaction runs before the cut to `max`, so the cap cannot leave a piece of a
 * key. The scan is linear and idempotent.
 *
 * @param text Text that may carry upstream or error output.
 * @param knownSecrets Secrets the caller holds, such as an API key or a PAT.
 * @param max Maximum length of the result.
 * @see docs/architecture.md
 */
export function redactLogText(
  text: string,
  knownSecrets: ReadonlyArray<string | null | undefined> = [],
  max = DEFAULT_LOG_TEXT_MAX,
): string {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }

  const secrets = normalizeSecrets(knownSecrets);
  let result = text;

  for (const secret of secrets) {
    result = result.split(secret).join("[REDACTED]");
  }

  if (secrets.length > 0) {
    result = result.replace(MASKED_TAIL, (match, tail: string) => {
      return secrets.some(
        (secret) =>
          tail.length >= MIN_MASKED_SUFFIX_LENGTH && secret.endsWith(tail),
      )
        ? "[REDACTED]"
        : match;
    });
  }

  result = redactSecrets(result).text;
  result = result.replace(GITHUB_TOKEN_ANYWHERE, "[REDACTED:github-token]");
  result = result.replace(BEARER_TOKEN, "Bearer [REDACTED]");
  result = result.replace(AUTHORIZATION_VALUE, "$1[REDACTED]");

  return result.slice(0, Math.max(0, max));
}

/**
 * An error as a short log-safe string, with secrets removed.
 *
 * @see docs/architecture.md
 */
export function errorText(error: unknown, max = ERROR_TEXT_MAX): string {
  return error instanceof Error
    ? redactLogText(error.message, [], max)
    : "unknown";
}

type Level = "info" | "warn" | "error";

/** One structured log line: `{"event": ..., ...fields}`. */
export function logEvent(
  level: Level,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  console[level](JSON.stringify({ event, ...fields }));
}

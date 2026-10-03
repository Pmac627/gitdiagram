import "server-only";

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { readCookie } from "~/server/http/cookies";
import { getDb, withImmediateTransaction } from "~/server/storage/db";
import { kvRead, kvWrite, kvWriteIfAbsent } from "~/server/storage/kv";

const SESSION_DAYS = 30;
const GENERATION_KEY = "operator:v1:session-generation";
const INSTALLATION_KEY = "operator:v1:installation-nonce";

export const ADMIN_SESSION_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-gd_admin" : "gd_admin";

function operatorToken(): string | null {
  const configured = process.env.OPERATOR_TOKEN?.trim();
  const fallback = process.env.VIDEO_ADMIN_TOKEN?.trim();
  const token = configured || fallback;

  return token && token.length >= 40 ? token : null;
}

/** Whether a sufficiently long operator token is configured. @see docs/flows/operator-live-ops.md */
export function isOperatorConfigured(): boolean {
  return operatorToken() !== null;
}

function sameText(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();

  return timingSafeEqual(digest(a), digest(b));
}

/** Check an operator token without leaking its length in timing. @see docs/flows/operator-live-ops.md */
export function isOperatorToken(presented: string): boolean {
  const token = operatorToken();

  return token !== null && sameText(presented.trim(), token);
}

function readGeneration(): number {
  const raw = kvRead(getDb(), GENERATION_KEY, Date.now()) ?? "0";
  const generation = Number(raw);

  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Invalid operator session generation.");
  }

  return generation;
}

function installationNonce(): string {
  const existing = kvRead(getDb(), INSTALLATION_KEY, Date.now());

  if (existing !== null) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(existing)) {
      throw new Error("Invalid operator installation nonce.");
    }

    return existing;
  }

  // BEGIN IMMEDIATE gives concurrent processes one winner on first use.
  return withImmediateTransaction((db) => {
    const now = Date.now();
    const candidate = randomBytes(32).toString("base64url");

    kvWriteIfAbsent(db, INSTALLATION_KEY, candidate, null, now);

    const installed = kvRead(db, INSTALLATION_KEY, now);

    if (!installed || !/^[A-Za-z0-9_-]{43}$/.test(installed)) {
      throw new Error("Invalid operator installation nonce.");
    }

    return installed;
  });
}

function sign(token: string, payload: string): string {
  return createHmac("sha256", token).update(payload).digest("base64url");
}

/** Create a browser session after SQLite reads or creates its installation nonce and reads its generation. @see docs/flows/operator-live-ops.md */
export function createAdminSession(now = Date.now()): {
  value: string;
  maxAgeSeconds: number;
} | null {
  const token = operatorToken();

  if (!token) {
    return null;
  }

  try {
    const nonce = installationNonce();
    const generation = readGeneration();
    const maxAgeSeconds = SESSION_DAYS * 86_400;
    const expires = now + maxAgeSeconds * 1000;
    const signature = sign(
      token,
      `admin-session:v3:${expires}:${generation}:${nonce}`,
    );

    return {
      value: `v3.${expires}.${generation}.${signature}`,
      maxAgeSeconds,
    };
  } catch {
    return null;
  }
}

function sessionParts(
  value: string | undefined | null,
  now: number,
): { expires: number; generation: number; signature: string } | null {
  if (!value) {
    return null;
  }

  const parts = value.split(".");
  const expires = Number(parts[1]);

  if (
    parts[0] !== "v3" ||
    parts.length !== 4 ||
    !Number.isSafeInteger(expires) ||
    expires <= now ||
    !/^\d{1,15}$/.test(parts[2]!)
  ) {
    return null;
  }

  const generation = Number(parts[2]);

  if (!Number.isSafeInteger(generation) || generation < 0) {
    return null;
  }

  return { expires, generation, signature: parts[3]! };
}

/** Verify a signed cookie against the current SQLite generation. @see docs/flows/operator-live-ops.md */
export async function verifyAdminSession(
  value: string | undefined | null,
  now = Date.now(),
): Promise<boolean> {
  const own = sessionParts(value, now);
  const token = operatorToken();

  if (own === null || token === null) {
    return false;
  }

  try {
    const nonce = installationNonce();
    const generation = readGeneration();

    return (
      own.generation === generation &&
      sameText(
        own.signature,
        sign(
          token,
          `admin-session:v3:${own.expires}:${own.generation}:${nonce}`,
        ),
      )
    );
  } catch {
    return false;
  }
}

/** Verify the operator cookie on a request. @see docs/flows/operator-live-ops.md */
export function verifyAdminRequest(request: Request): Promise<boolean> {
  return verifyAdminSession(readCookie(request, ADMIN_SESSION_COOKIE));
}

/** Revoke all existing browser sessions in one SQLite transaction. @see docs/flows/operator-live-ops.md */
export async function revokeAdminSessions(): Promise<number> {
  installationNonce();

  return withImmediateTransaction((db) => {
    const current = Number(kvRead(db, GENERATION_KEY, Date.now()) ?? "0");

    if (
      !Number.isSafeInteger(current) ||
      current < 0 ||
      current === Number.MAX_SAFE_INTEGER
    ) {
      throw new Error("Invalid operator session generation.");
    }

    const next = current + 1;

    kvWrite(db, GENERATION_KEY, String(next), null, Date.now());

    return next;
  });
}

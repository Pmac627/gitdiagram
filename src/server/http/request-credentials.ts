import { cookies } from "next/headers";
import { z } from "zod";

import {
  AI_PROVIDERS,
  getBaseUrl,
  getProvider,
  type AIProvider,
} from "~/server/generate/model-config";
import { isSameOriginRequest } from "~/server/http/same-origin";

export const CREDENTIAL_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
export const MAX_STORED_CREDENTIAL_BYTES = 2_048;

export const credentialKindSchema = z.enum(["openai_api_key", "github_pat"]);
export type CredentialKind = z.infer<typeof credentialKindSchema>;

export const storedCredentialSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_STORED_CREDENTIAL_BYTES)
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <= MAX_STORED_CREDENTIAL_BYTES,
  );

export const MAX_STORED_API_KEY_COOKIE_BYTES = 4_096;

export const aiProviderSchema = z.enum(AI_PROVIDERS);

/**
 * The API key cookie stores the key with the provider (and, for
 * openai-compatible, the endpoint) it was saved for. A cookie without this
 * binding is ignored, so a key never reaches an endpoint it was not meant for.
 * @see docs/configuration.md
 */
const boundApiKeySchema = z.strictObject({
  version: z.literal(1),
  key: storedCredentialSchema,
  provider: aiProviderSchema,
  baseUrl: z.string().max(MAX_STORED_CREDENTIAL_BYTES).optional(),
});
type BoundApiKey = z.infer<typeof boundApiKeySchema>;

export interface CredentialStatus {
  openaiApiKeyConfigured: boolean;
  githubPatConfigured: boolean;
  /** The provider the server is configured for now. */
  configuredProvider: AIProvider;
  /** The provider the stored API key was saved for, or null when none. */
  apiKeyProvider: AIProvider | null;
}

export interface RequestCredentials {
  apiKey?: string;
  githubPat?: string;
}

const COOKIE_NAMES: Record<CredentialKind, string> = {
  openai_api_key: "gitdiagram_openai_api_key",
  github_pat: "gitdiagram_github_pat",
};

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/api",
    maxAge,
  };
}

function readCredential(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
  kind: Exclude<CredentialKind, "openai_api_key">,
): string | undefined {
  const parsed = storedCredentialSchema.safeParse(
    cookieStore.get(COOKIE_NAMES[kind])?.value,
  );
  return parsed.success ? parsed.data : undefined;
}

function readBoundApiKey(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
): BoundApiKey | undefined {
  const raw = cookieStore.get(COOKIE_NAMES.openai_api_key)?.value;
  if (
    !raw ||
    new TextEncoder().encode(raw).byteLength > MAX_STORED_API_KEY_COOKIE_BYTES
  ) {
    return undefined;
  }

  try {
    const parsed = boundApiKeySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    // A legacy cookie holds the bare key with no provider; it is ignored.
    return undefined;
  }
}

function endpointFor(provider: AIProvider): string | undefined {
  return provider === "openai-compatible" ? getBaseUrl(provider) : undefined;
}

/** Return the stored key only when it was saved for the current provider. */
function readApplicableApiKey(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
): string | undefined {
  const bound = readBoundApiKey(cookieStore);
  if (!bound) {
    return undefined;
  }

  if (bound.provider !== getProvider()) {
    return undefined;
  }

  if (bound.provider === "openai-compatible") {
    try {
      if (
        bound.baseUrl === undefined ||
        bound.baseUrl !== endpointFor(bound.provider)
      ) {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }

  return bound.key;
}

function getStatus(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
): CredentialStatus {
  return {
    openaiApiKeyConfigured: Boolean(readApplicableApiKey(cookieStore)),
    githubPatConfigured: Boolean(readCredential(cookieStore, "github_pat")),
    configuredProvider: getProvider(),
    apiKeyProvider: readBoundApiKey(cookieStore)?.provider ?? null,
  };
}

export async function getCredentialStatus(): Promise<CredentialStatus> {
  return getStatus(await cookies());
}

/**
 * Store a credential. An API key needs the provider it is for; a GitHub token
 * takes none.
 * @see docs/configuration.md
 */
export async function setCredential(
  kind: CredentialKind,
  value: string,
  provider?: AIProvider,
): Promise<CredentialStatus> {
  const credential = storedCredentialSchema.parse(value);

  let stored = credential;
  if (kind === "openai_api_key") {
    const boundProvider = aiProviderSchema.parse(provider);
    const bound: BoundApiKey = {
      version: 1,
      key: credential,
      provider: boundProvider,
      ...(boundProvider === "openai-compatible"
        ? { baseUrl: endpointFor(boundProvider) }
        : {}),
    };
    stored = JSON.stringify(bound);
  }

  const cookieStore = await cookies();
  cookieStore.set(
    COOKIE_NAMES[kind],
    stored,
    cookieOptions(CREDENTIAL_COOKIE_MAX_AGE_SECONDS),
  );
  return getStatus(cookieStore);
}

export async function clearCredential(
  kind: CredentialKind,
): Promise<CredentialStatus> {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAMES[kind], "", cookieOptions(0));
  return getStatus(cookieStore);
}

export async function resolveRequestCredentials(
  request: Request,
  explicit: RequestCredentials = {},
): Promise<RequestCredentials> {
  if (!isSameOriginRequest(request)) {
    return explicit;
  }

  const cookieStore = await cookies();
  return {
    apiKey: explicit.apiKey ?? readApplicableApiKey(cookieStore),
    githubPat: explicit.githubPat ?? readCredential(cookieStore, "github_pat"),
  };
}

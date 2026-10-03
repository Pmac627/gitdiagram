"use client";

import {
  getProviderLabel,
  type AIProvider,
} from "~/server/generate/model-config";

import { CredentialDialog, type ProviderContext } from "./credential-dialog";

interface ApiKeyDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved?: () => void | Promise<void>;
}

/** Before the server status loads, the copy follows the default provider. */
const DEFAULT_PROVIDER: AIProvider = "openai";
const API_KEYS_URLS: Partial<Record<AIProvider, string>> = {
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  gemini: "https://aistudio.google.com/apikey",
  grok: "https://console.x.ai",
};

function providerOf(context: ProviderContext): AIProvider {
  return context.configuredProvider ?? DEFAULT_PROVIDER;
}

function buildPrompt(provider: AIProvider, url: string | undefined): string {
  const label = getProviderLabel(provider);

  return [
    `Help me set up an ${label} API key for GitDiagram.`,
    url
      ? `Use my browser to open ${url} and help me create a secret key named GitDiagram in my chosen project.`
      : "Help me find or create a secret key for the endpoint this GitDiagram server uses.",
    `Explain that diagram generations using this key are billed to my ${label} API account. If billing needs setup, walk me through it and ask before adding payment details or buying credits.`,
    `Help me paste the key directly into GitDiagram's ${label} API key dialog and save it. Do not put the key in chat, logs, or files.`,
    "If you cannot use my browser, walk me through these steps briefly.",
  ].join("\n\n");
}

function describeSetup(context: ProviderContext) {
  const provider = providerOf(context);
  const label = getProviderLabel(provider);
  const url = API_KEYS_URLS[provider];

  return {
    instructions:
      provider === "openai" ? (
        <>
          Create a secret key in your OpenAI project. Generations with this key
          are billed to your OpenAI account.
        </>
      ) : provider === "openai-compatible" ? (
        <>
          Use a key for the {label} endpoint this server is set up for.
          Generations with this key are billed by that endpoint.
        </>
      ) : (
        <>
          Create a secret key with this server&apos;s provider. Generations with
          this key are billed to your account there.
        </>
      ),
    url,
    linkLabel: `Create key on ${label}`,
    aiPrompt: buildPrompt(provider, url),
  };
}

function describeMismatch(context: ProviderContext) {
  const { apiKeyProvider, configuredProvider, isConfigured } = context;
  if (isConfigured || apiKeyProvider === null || configuredProvider === null) {
    return null;
  }

  const saved =
    apiKeyProvider === configuredProvider
      ? "a different endpoint"
      : getProviderLabel(apiKeyProvider);

  return (
    <p
      role="status"
      className="text-xs font-medium text-amber-800 dark:text-amber-300"
    >
      A key saved for {saved} does not apply to this server now. Paste a new key
      to use your own key.
    </p>
  );
}

export function ApiKeyDialog(props: ApiKeyDialogProps) {
  return (
    <CredentialDialog
      {...props}
      credential="openai_api_key"
      title="API key"
      inputLabel={(context) =>
        `${getProviderLabel(providerOf(context))} API key`
      }
      description="Use your own key to generate diagrams with your own account."
      setup={describeSetup}
      notice={describeMismatch}
      dataUsage={
        <>
          Your key is kept in a protected browser cookie for 30 days. Page
          JavaScript cannot read it. GitDiagram uses it only on the server to
          generate your diagrams, and only for the provider it was saved for.
        </>
      }
    />
  );
}

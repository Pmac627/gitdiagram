import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiKeyDialog } from "~/components/api-key-dialog";

const mocks = vi.hoisted(() => ({
  clearCredential: vi.fn(),
  getCredentialStatus: vi.fn(),
  saveCredential: vi.fn(),
}));

vi.mock("~/features/credentials/api", () => ({
  clearCredential: mocks.clearCredential,
  getCredentialStatus: mocks.getCredentialStatus,
  saveCredential: mocks.saveCredential,
}));

function status(overrides: Record<string, unknown> = {}) {
  return {
    openaiApiKeyConfigured: false,
    githubPatConfigured: false,
    apiKeyProvider: null,
    configuredProvider: "anthropic",
    ...overrides,
  };
}

describe("API key dialog provider binding", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getCredentialStatus.mockResolvedValue(status());
    mocks.saveCredential.mockResolvedValue(
      status({ openaiApiKeyConfigured: true, apiKeyProvider: "anthropic" }),
    );
    mocks.clearCredential.mockResolvedValue(status());
  });

  it("names the configured provider the key is for", async () => {
    render(<ApiKeyDialog isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(mocks.getCredentialStatus).toHaveBeenCalled());

    expect(await screen.findByText(/Anthropic/)).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Anthropic API key/, { selector: "input" }),
    ).toBeInTheDocument();
  });

  it("saves the key together with the configured provider", async () => {
    render(<ApiKeyDialog isOpen onClose={vi.fn()} />);
    const input = await screen.findByLabelText(/Anthropic API key/, {
      selector: "input",
    });

    fireEvent.change(input, { target: { value: "sk-ant-entry" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() =>
      expect(mocks.saveCredential).toHaveBeenCalledWith(
        "openai_api_key",
        "sk-ant-entry",
        "anthropic",
      ),
    );
  });

  it("does not offer a key saved for a different provider as saved", async () => {
    mocks.getCredentialStatus.mockResolvedValue(
      status({
        openaiApiKeyConfigured: false,
        apiKeyProvider: "openai",
        configuredProvider: "anthropic",
      }),
    );
    render(<ApiKeyDialog isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(mocks.getCredentialStatus).toHaveBeenCalled());

    expect(
      screen.queryByText("Key saved. Paste a new one to replace it."),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByText(/saved for (a different provider|OpenAI)/i),
    ).toBeInTheDocument();
  });
});

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "~/app/providers";

const mocks = vi.hoisted(() => ({
  migrateLegacyCredentialStorage: vi.fn(),
}));

vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("~/features/credentials/api", () => ({
  migrateLegacyCredentialStorage: mocks.migrateLegacyCredentialStorage,
}));

describe("AppProviders credential migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the app immediately and starts the migration once", async () => {
    let completeMigration!: (complete: boolean) => void;
    mocks.migrateLegacyCredentialStorage.mockReturnValue(
      new Promise<boolean>((resolve) => {
        completeMigration = resolve;
      }),
    );

    render(
      <AppProviders>
        <main>Application content</main>
      </AppProviders>,
    );

    expect(screen.getByText("Application content")).toBeInTheDocument();
    expect(mocks.migrateLegacyCredentialStorage).toHaveBeenCalledOnce();

    completeMigration(true);

    await waitFor(() => expect(screen.getByText("Application content")));
    expect(mocks.migrateLegacyCredentialStorage).toHaveBeenCalledOnce();
  });

  it("keeps rendering after a failed migration", async () => {
    mocks.migrateLegacyCredentialStorage.mockRejectedValue(
      new Error("storage unavailable"),
    );

    render(
      <AppProviders>
        <main>Application content</main>
      </AppProviders>,
    );

    expect(screen.getByText("Application content")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.migrateLegacyCredentialStorage).toHaveBeenCalledOnce(),
    );
    expect(screen.getByText("Application content")).toBeInTheDocument();
  });
});

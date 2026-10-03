"use client";

import { useEffect } from "react";
import { ThemeProvider } from "next-themes";

import { migrateLegacyCredentialStorage } from "~/features/credentials/api";

function LegacyCredentialMigration() {
  useEffect(() => {
    void migrateLegacyCredentialStorage().catch(() => {
      // A later app load can retry the migration.
    });
  }, []);

  return null;
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      storageKey="gitdiagram-theme"
    >
      <LegacyCredentialMigration />
      {children}
    </ThemeProvider>
  );
}

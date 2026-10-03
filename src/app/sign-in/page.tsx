import type { Metadata } from "next";

import { safeNextPath } from "~/lib/safe-next-path";
import { SignInForm } from "./sign-in-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in · GitDiagram",
  robots: { index: false, follow: false },
};

/** Show the operator sign-in form. @see docs/flows/operator-live-ops.md */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col justify-center gap-6 px-4 py-12">
      <h1 className="text-3xl font-bold">Sign in</h1>
      <SignInForm next={safeNextPath(next)} />
    </main>
  );
}

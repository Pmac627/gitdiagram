import Link from "next/link";

import { GITHUB_REPO_URL } from "~/lib/site";

export function Footer() {
  return (
    <footer className="mt-auto border-black pt-4 pb-9 sm:border-t-[3px] sm:py-4 lg:px-8 dark:border-black">
      <div className="container mx-auto flex h-8 max-w-4xl items-center justify-center">
        <span className="text-base font-medium text-black sm:text-sm dark:text-neutral-100">
          A private fork of{" "}
          <Link
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="neo-link hover:underline"
          >
            GitDiagram
          </Link>
        </span>
      </div>
    </footer>
  );
}

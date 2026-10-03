import "~/styles/globals.css";

import { GeistSans } from "geist/font/sans";
import { type Metadata } from "next";
import { Header } from "~/components/header";
import { Footer } from "~/components/footer";
import { AppProviders } from "./providers";
import { SITE_URL } from "~/lib/site";

export const metadata: Metadata = {
  title: "GitDiagram",
  description:
    "Turn any GitHub repository into an interactive diagram for visualization in seconds.",
  metadataBase: new URL(SITE_URL),
  keywords: [
    "github",
    "git diagram",
    "git diagram generator",
    "git diagram tool",
    "git diagram maker",
    "git diagram creator",
    "diagram",
    "repository",
    "visualization",
    "code structure",
    "system design",
    "software architecture",
    "software design",
    "software engineering",
    "software development",
    "open source",
    "open source software",
    "gitdiagram",
  ],
  openGraph: {
    type: "website",
    locale: "en_US",
    url: SITE_URL,
    title: "GitDiagram - Repository to Diagram in Seconds",
    description:
      "Turn any GitHub repository into an interactive diagram for visualization.",
    siteName: "GitDiagram",
  },
  twitter: {
    card: "summary_large_image",
    title: "GitDiagram - Repository to Diagram in Seconds",
    description:
      "Turn any GitHub repository into an interactive diagram for visualization.",
  },
  robots: {
    index: false,
    follow: false,
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable}`}
    >
      <body className="flex min-h-screen flex-col">
        <AppProviders>
          <Header />
          <div className="flex-grow">{children}</div>
          <Footer />
        </AppProviders>
      </body>
    </html>
  );
}

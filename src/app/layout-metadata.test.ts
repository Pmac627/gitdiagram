import { describe, expect, it, vi } from "vitest";

vi.mock("~/styles/globals.css", () => ({}));
vi.mock("geist/font/sans", () => ({ GeistSans: { variable: "geist" } }));
vi.mock("~/components/header", () => ({ Header: () => null }));
vi.mock("~/components/footer", () => ({ Footer: () => null }));
vi.mock("./providers", () => ({ AppProviders: () => null }));

import { metadata } from "./layout";

describe("root layout metadata", () => {
  it("marks every page noindex and nofollow", () => {
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
  });

  it("does not let googleBot re-enable indexing", () => {
    const robots = metadata.robots;
    const googleBot =
      robots && typeof robots === "object" && "googleBot" in robots
        ? robots.googleBot
        : undefined;

    if (googleBot && typeof googleBot === "object") {
      expect(googleBot).not.toMatchObject({ index: true });
      expect(googleBot).not.toMatchObject({ follow: true });
    }
  });
});

describe("root layout metadata, private fork branding", () => {
  it("uses the private fork host as metadataBase", () => {
    expect(String(metadata.metadataBase)).toBe("https://gitdiagram.tuple.pro/");
  });

  it("names no gitdiagram.com address, upstream author or social handle", () => {
    const text = JSON.stringify(metadata);

    expect(text).not.toContain("gitdiagram.com");
    expect(text.toLowerCase()).not.toContain("ahmedkhaleel");
    expect(text.toLowerCase()).not.toContain("ahmed khaleel");
    expect(text).not.toContain("@");
  });

  it("sets no twitter creator, authors or creator", () => {
    expect(metadata.authors).toBeUndefined();
    expect(metadata.creator).toBeUndefined();
    expect(metadata.twitter).not.toHaveProperty("creator");
  });
});

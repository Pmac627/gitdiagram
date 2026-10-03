import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Footer } from "./footer";

const UPSTREAM_URL = "https://github.com/ahmedkhaleel2004/gitdiagram";

afterEach(cleanup);

describe("Footer", () => {
  it("credits the upstream project with a link to its repository", () => {
    render(<Footer />);

    const links = screen.getAllByRole("link");
    const credit = links.find(
      (link) => link.getAttribute("href") === UPSTREAM_URL,
    );

    expect(credit).toBeDefined();
    expect(credit?.getAttribute("rel")).toContain("noopener");
  });

  it("has exactly one link, the upstream credit", () => {
    render(<Footer />);

    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("links to no gitdiagram.com page and no personal site of the upstream author", () => {
    render(<Footer />);

    for (const link of screen.getAllByRole("link")) {
      const href = link.getAttribute("href") ?? "";

      expect(href).not.toContain("gitdiagram.com");
      expect(href).not.toContain("ahmedkhaleel.com");
    }
  });
});

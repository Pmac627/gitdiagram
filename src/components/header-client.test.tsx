import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("./theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("./new-badge", () => ({ NewBadge: () => null }));

import { HeaderClient } from "./header-client";

describe("HeaderClient", () => {
  it("renders with no star count prop and shows no star glyph or count", () => {
    const { container } = render(<HeaderClient />);

    expect(container.textContent).not.toContain("★");
    expect(screen.queryByText(/^\d+(\.\d+)?k?$/i)).toBeNull();
  });

  it("links nowhere to the upstream repository", () => {
    render(<HeaderClient />);

    for (const link of screen.queryAllByRole("link")) {
      expect(link.getAttribute("href") ?? "").not.toContain("ahmedkhaleel");
    }
  });
});

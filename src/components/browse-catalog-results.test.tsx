import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { BrowsePageResult } from "~/features/browse/catalog";

import { BrowseCatalogResults } from "./browse-catalog-results";

afterEach(cleanup);

function page(repos: string[]): BrowsePageResult {
  return {
    items: repos.map((repo) => ({
      username: "owner",
      repo,
      lastSuccessfulAt: "2026-09-20T12:00:00.000Z",
      stargazerCount: 10,
    })),
    total: repos.length,
    page: 1,
    pageSize: 20,
    totalPages: 1,
    sort: "stars_desc",
    q: "",
  };
}

function results(result: BrowsePageResult) {
  return (
    <BrowseCatalogResults
      closeHoverPreview={() => {}}
      desktopHoverEnabled={false}
      handlePageChange={() => {}}
      handleRepoHoverMove={() => {}}
      handleRepoHoverStart={() => {}}
      hoverPreview={null}
      hoverPreviewDiagram={null}
      hoverPreviewElementRef={{ current: null }}
      hoverPreviewStatus="idle"
      result={result}
    />
  );
}

it("lists one row per repository as the listings change", () => {
  const rows = () => screen.getAllByRole("row").slice(1);
  const view = render(results(page(["a", "b", "c"])));
  expect(rows()).toHaveLength(3);
  view.rerender(results(page(["x", "y"])));
  expect(rows()).toHaveLength(2);
  view.rerender(results(page(["only"])));
  expect(rows()).toHaveLength(1);
});

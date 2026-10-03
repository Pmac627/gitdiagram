import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { AdminState } from "~/features/admin/types";
import { BudgetTiles } from "./budget-tiles";
import { ControlsPanel } from "./controls-panel";

const state: AdminState = {
  now: 0,
  voicePausedUntil: null,
  voiceCreditUsd: null,
};

afterEach(cleanup);

// Phase 4 decision (1): the pause switch is gone. The panel takes no props and
// keeps two things: the model note and this browser's admin-tools toggle.
function renderControls() {
  render(<ControlsPanel />);
}

describe("video making controls", () => {
  it("has no pause switch, saving state or save error", () => {
    renderControls();
    expect(
      screen.queryByRole("switch", { name: "Pause all new videos" }),
    ).toBeNull();
    expect(screen.queryByText(/Pause all new videos/)).toBeNull();
    expect(screen.queryByText(/Saving/)).toBeNull();
    expect(screen.queryByText(/Changes are live/)).toBeNull();
  });

  it("shows the admin-tools toggle without waiting for any state", () => {
    renderControls();
    expect(
      screen.getByRole("switch", {
        name: "Show admin controls on video pages",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("has no audience, priority-place or limited-country choices", () => {
    renderControls();
    for (const name of [
      "Who can make new videos",
      "Limited countries",
      "Priority places",
    ]) {
      expect(screen.queryByRole("radiogroup", { name })).toBeNull();
    }
    expect(screen.queryAllByRole("radio")).toEqual([]);
  });

  it("has no per-day limit fields, set buttons or reset-to-default buttons", () => {
    renderControls();
    expect(screen.queryAllByRole("textbox")).toEqual([]);
    expect(screen.queryByRole("button", { name: /^Set / })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /to the default$/ }),
    ).toBeNull();
  });

  it("describes who gets which model the way videos are made", () => {
    renderControls();
    expect(
      screen.getByText(/written by Claude Opus and designed by GPT-6 Sol/),
    ).toBeInTheDocument();
  });
});

describe("the voice balance tile", () => {
  it("makes no per-video estimate it cannot back up", () => {
    render(<BudgetTiles state={{ ...state, voiceCreditUsd: 4 }} />);
    expect(screen.getByText("$4.00")).toBeInTheDocument();
    expect(screen.queryByText(/videos at/)).toBeNull();
  });

  it("shows no budget, MP4, reset or complimentary token tile", () => {
    render(<BudgetTiles state={state} />);
    expect(screen.queryByText(/Videos today/)).toBeNull();
    expect(screen.queryByText(/MP4s today/)).toBeNull();
    expect(screen.queryByText(/Free diagram tokens today/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Reset today's/ })).toBeNull();
  });
});

describe("accessible names", () => {
  it("gives every dashboard button its own name", () => {
    render(
      <>
        <ControlsPanel />
        <BudgetTiles state={state} />
      </>,
    );
    const names = screen
      .queryAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent);
    expect(new Set(names).size).toBe(names.length);
  });
});

"use client";

import type { AdminState } from "~/features/admin/types";
import { Tile } from "./ui";

// The balance behind video making: the narrator's prepaid voice credit.

export function BudgetTiles({ state }: { state: AdminState | null }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:col-span-2">
      <div className="col-span-2">
        <Tile
          label="Voice balance (OpenRouter)"
          value={
            state?.voiceCreditUsd == null
              ? "–"
              : `$${state.voiceCreditUsd.toFixed(2)}`
          }
          sub={
            state?.voicePausedUntil
              ? `Ran out: new videos paused until ${new Date(state.voicePausedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
              : state?.voiceCreditUsd == null
                ? "Balance unreadable"
                : "Prepaid. New videos pause if it runs out."
          }
        />
      </div>
    </div>
  );
}

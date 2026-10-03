"use client";

import { Switch } from "~/components/ui/switch";
import { setAdminTools, useAdminTools } from "~/features/admin/tools";
import { Panel } from "./ui";

// Video making. There are no live switches: the only safeguards are automatic
// (the voice-credit check and the cap on paid runs). What is left is a note on
// the models and this browser's admin-tools toggle.

export function ControlsPanel() {
  const adminTools = useAdminTools();

  return (
    <Panel title="Video making" className="lg:col-span-3">
      <div className="flex flex-col gap-5">
        <p className="text-xs text-[hsl(var(--neo-soft-text))]">
          Every video is written by Claude Opus and designed by GPT-6 Sol.
        </p>

        <label className="flex items-center justify-between gap-4 rounded-md border-2 border-black bg-white/70 p-3 dark:bg-black/20">
          <span>
            <span className="block font-semibold">
              Show admin controls on video pages
            </span>
            <span className="block text-xs text-[hsl(var(--neo-soft-text))]">
              Adds a Regenerate video button, in this browser only. Turn it off
              to see pages the way visitors do.
            </span>
          </span>
          <Switch
            checked={adminTools}
            onCheckedChange={setAdminTools}
            aria-label="Show admin controls on video pages"
          />
        </label>
      </div>
    </Panel>
  );
}

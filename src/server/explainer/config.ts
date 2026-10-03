import "server-only";

import { hasKeyFor, plannerModels } from "./planner";
import { isVoiceConfigured } from "./voice";

/** Explainer videos stay off unless a deployment opts in. */
export function isVideoExplainerEnabled(): boolean {
  return process.env.VIDEO_EXPLAINER_ENABLED === "1";
}

/** MP4 renders and posters need a headless Chromium, so they are opt-in. */
export function isVideoRenderEnabled(): boolean {
  return process.env.VIDEO_RENDER_ENABLED?.trim() === "1";
}

/** Every configured model's provider key is set, and the narrator's too. */
export function canGenerateVideos(): boolean {
  return plannerModels().every(hasKeyFor) && isVoiceConfigured();
}

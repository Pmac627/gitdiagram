// Shapes shared by the operator dashboard (/admin) and its API routes.

export interface AdminState {
  now: number;
  /** When new videos can be voiced again (ms); null when they can now or unknown. */
  voicePausedUntil: number | null;
  /** The voice's prepaid OpenRouter balance in USD; null when unreadable. */
  voiceCreditUsd: number | null;
}

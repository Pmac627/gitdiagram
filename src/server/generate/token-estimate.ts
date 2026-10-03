/**
 * Estimate prompt tokens locally when a provider cannot count them.
 * @see docs/flows/diagram-generation.md
 */
export function estimateTokens(text: string): number {
  if (typeof text !== "string") {
    throw new TypeError("Text is required for token estimation.");
  }

  return text.length === 0 ? 0 : Math.ceil(text.length / 3) + 32;
}

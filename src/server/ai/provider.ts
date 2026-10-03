import type { ZodType } from "zod";

import type { GenerationTokenUsage } from "~/features/diagram/cost";

/**
 * Set the model reasoning effort.
 * @see docs/flows/diagram-generation.md
 */
export type ReasoningEffort = "low" | "medium" | "high";

/**
 * Set the model text detail.
 * @see docs/flows/diagram-generation.md
 */
type TextVerbosity = "low" | "medium" | "high";

/**
 * Define one text request to a model.
 * @see docs/flows/diagram-generation.md
 */
export interface TextRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  reasoningEffort?: ReasoningEffort;
  textVerbosity?: TextVerbosity;
  outputSchema?: ZodType;
  signal?: AbortSignal;
  clientRequestId?: string;
}

/**
 * Define one structured request to a model.
 * @see docs/flows/diagram-generation.md
 */
export interface StructuredRequest<T> extends Omit<
  TextRequest,
  "outputSchema"
> {
  schema: ZodType<T>;
  schemaName: string;
}

/**
 * Define one input token count request.
 * @see docs/flows/diagram-generation.md
 */
export interface TokenCountRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  clientRequestId?: string;
}

/**
 * Provide text, structured output, and an optional input token count.
 * @see docs/flows/diagram-generation.md
 */
export interface GenerationProvider {
  streamText(request: TextRequest): Promise<{
    stream: AsyncGenerator<string, void, void>;
    usagePromise: Promise<GenerationTokenUsage | null>;
  }>;
  parseStructured<T>(request: StructuredRequest<T>): Promise<{
    output: T;
    rawText: string;
    usage: GenerationTokenUsage | null;
  }>;
  countInputTokens?(request: TokenCountRequest): Promise<number>;
}

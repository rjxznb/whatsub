import type { Settings } from "../../types/settings";

export interface ProviderRequest {
  systemPrompt: string;
  userPrompt: string;
}

/**
 * A provider streams text chunks. Caller is responsible for parsing JSON-lines.
 */
export interface Provider {
  stream(req: ProviderRequest): AsyncIterable<string>;
}

export type ProviderFactory = (settings: Settings) => Provider;

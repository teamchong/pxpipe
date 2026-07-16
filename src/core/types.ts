/**
 * Minimal Anthropic Messages API request types — only the fields pxpipe
 * actually reads or rewrites. Anything else passes through untouched.
 *
 * Shape reference: https://docs.anthropic.com/en/api/messages
 */

export interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}

export interface ImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    data: string;
  };
  cache_control?: CacheControl;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<TextBlock | ImageBlock>;
  is_error?: boolean;
  cache_control?: CacheControl;
}

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

export interface CacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
}

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolDef {
  /** Absent or "custom" = client-defined tool (description/input_schema allowed).
   *  Any other value is a native server-side tool with a fixed API schema that
   *  rejects extra fields — pxpipe must pass those entries through untouched (#43). */
  type?: string;
  name: string;
  description?: string;
  input_schema?: unknown;
  cache_control?: CacheControl;
}

export type SystemField = string | Array<TextBlock | ImageBlock>;

/** Anthropic token usage block — same shape on streaming (message_start) and non-streaming. */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** Split by tier (5m=1.25×, 1h=2× base) for honest cost; absent on older API / non-cache requests. */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  /** Server tool billing (web search = per-request, not per-token); absent when unused. */
  server_tool_use?: {
    web_search_requests?: number;
  };
  /** OpenAI prompt-cache hits — the subset of `input_tokens` served from cache
   *  (billed at ~0.1× for the gpt-5 family). Mapped from `input_tokens_details`
   *  / `prompt_tokens_details.cached_tokens`. Anthropic uses cache_read instead. */
  cached_tokens?: number;
}

export interface MessagesRequest {
  model: string;
  messages: Message[];
  system?: SystemField;
  tools?: ToolDef[];
  // … plus all the other fields we don't touch (max_tokens, temperature, …)
  [k: string]: unknown;
}

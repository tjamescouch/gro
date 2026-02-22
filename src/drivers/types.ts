export interface ChatMessage {
  role: string;
  from: string;
  content: string;
  reasoning?: string;
  /** Importance weight (0.0–1.0). Set by  stream markers.
   *  Higher values signal the message should be preserved longer during paging. */
  importance?: number;
  /** When role==="tool", the id of the tool call being answered. */
  tool_call_id?: string;
  /** Optional: tool/function name for clarity. */
  name?: string;
}

export interface ChatToolCall {
  id: string;
  type: "function" | "custom";
  function: { name: string; arguments: string };
  raw?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface ChatOutput {
  text: string;
  toolCalls: ChatToolCall[];
  reasoning?: string;
  usage?: TokenUsage;
}

export interface ChatDriver {
  chat(messages: ChatMessage[], opts?: {
    model?: string;
    tools?: any[];
    onToken?: (s: string) => void;
    onReasoningToken?: (s: string) => void;
    onToolCallDelta?: (s: ChatToolCall) => void;
    /** 0.0–1.0 fraction of maxTokens to allocate for extended thinking. 0 = disabled. */
    thinkingBudget?: number;
    /** Sampling temperature (0.0–2.0, default varies by provider) */
    temperature?: number;
    /** Top-k sampling (integer, default varies by provider) */
    top_k?: number;
    /** Top-p (nucleus) sampling (0.0–1.0, default varies by provider) */
    top_p?: number;
    /** Request logprobs from the provider (for LFS face signals) */
    logprobs?: boolean;
    /** Number of top logprobs to return (default: 5) */
    top_logprobs?: number;
    /** Called per token with logprob data when logprobs is enabled */
    onLogprobs?: (data: { token: string; logprob: number; top_logprobs?: Array<{ token: string; logprob: number }> }) => void;
  }): Promise<ChatOutput>;
}

export interface ChatMessage {
  role: string;
  from: string;
  content: string;
  reasoning?: string;
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

export interface ChatOutput {
  text: string;
  toolCalls: ChatToolCall[];
  reasoning?: string;
}

export interface ChatDriver {
  chat(messages: ChatMessage[], opts?: {
    model?: string;
    tools?: any[];
    onToken?: (s: string) => void;
    onReasoningToken?: (s: string) => void;
    onToolCallDelta?: (s: ChatToolCall) => void;
  }): Promise<ChatOutput>;
}

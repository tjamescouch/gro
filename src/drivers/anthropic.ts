/**
 * Anthropic Messages API driver.
 * Direct HTTP — no SDK dependency.
 */
import { Logger } from "../logger.js";
import { rateLimiter } from "../utils/rate-limiter.js";
import { timedFetch } from "../utils/timed-fetch.js";
import { MAX_RETRIES, isRetryable, retryDelay, sleep } from "../utils/retry.js";
import { groError, asError, isGroError, errorLogFields } from "../errors.js";
import type { ChatDriver, ChatMessage, ChatOutput, ChatToolCall } from "./types.js";

export interface AnthropicDriverConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * Convert tool definitions from OpenAI format to Anthropic format.
 * OpenAI: { type: "function", function: { name, description, parameters } }
 * Anthropic: { name, description, input_schema }
 */
function convertToolDefs(tools: any[]): any[] {
  return tools.map(t => {
    if (t.type === "function" && t.function) {
      return {
        name: t.function.name,
        description: t.function.description || "",
        input_schema: t.function.parameters || { type: "object", properties: {} },
      };
    }
    // Already in Anthropic format — pass through
    return t;
  });
}

/**
 * Convert internal messages (OpenAI-style) to Anthropic Messages API format.
 *
 * Key differences:
 * - Assistant tool calls become content blocks with type "tool_use"
 * - Tool result messages become user messages with type "tool_result" content blocks
 * - Anthropic requires strictly alternating user/assistant roles
 */
function convertMessages(messages: ChatMessage[]): { system: string | undefined; apiMessages: any[] } {
  let systemPrompt: string | undefined;
  const apiMessages: any[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemPrompt = systemPrompt ? systemPrompt + "\n" + m.content : m.content;
      continue;
    }

    if (m.role === "assistant") {
      const content: any[] = [];
      if (m.content) content.push({ type: "text", text: m.content });

      // Convert OpenAI-style tool_calls to Anthropic tool_use blocks
      const toolCalls = (m as any).tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          let input: any;
          try { input = JSON.parse(tc.function.arguments || "{}"); } catch { input = {}; }
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }

      if (content.length > 0) {
        apiMessages.push({ role: "assistant", content });
      }
      continue;
    }

    if (m.role === "tool") {
      // Tool results must be in a user message with tool_result content blocks
      const block = {
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: m.content,
      };

      // Group consecutive tool results into a single user message
      const last = apiMessages[apiMessages.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) &&
          last.content.length > 0 && last.content[0].type === "tool_result") {
        last.content.push(block);
      } else {
        apiMessages.push({ role: "user", content: [block] });
      }
      continue;
    }

    // Regular user messages
    apiMessages.push({ role: "user", content: m.content });
  }

  return { system: systemPrompt, apiMessages };
}

export function makeAnthropicDriver(cfg: AnthropicDriverConfig): ChatDriver {
  const base = (cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const endpoint = `${base}/v1/messages`;
  const model = cfg.model ?? "claude-sonnet-4-20250514";
  const maxTokens = cfg.maxTokens ?? 4096;
  const timeoutMs = cfg.timeoutMs ?? 2 * 60 * 60 * 1000;

  async function chat(messages: ChatMessage[], opts?: any): Promise<ChatOutput> {
    await rateLimiter.limit("llm-ask", 1);

    const onToken: ((t: string) => void) | undefined = opts?.onToken;
    const resolvedModel = opts?.model ?? model;

    const { system: systemPrompt, apiMessages } = convertMessages(messages);

    const body: any = {
      model: resolvedModel,
      max_tokens: maxTokens,
      messages: apiMessages,
    };
    if (systemPrompt) body.system = systemPrompt;

    // Tools support — convert from OpenAI format to Anthropic format
    if (Array.isArray(opts?.tools) && opts.tools.length) {
      body.tools = convertToolDefs(opts.tools);
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    };

    const RETRYABLE_STATUS = new Set([429, 503, 529]);
    let requestId: string | undefined;

    try {
      let res!: Response;
      for (let attempt = 0; ; attempt++) {
        res = await timedFetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          where: "driver:anthropic",
          timeoutMs,
        });

        if (res.ok) break;

        if (isRetryable(res.status) && attempt < MAX_RETRIES) {
          const delay = retryDelay(attempt);
          Logger.warn(`Anthropic ${res.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delay)}ms`);
          await sleep(delay);
          continue;
        }

        const text = await res.text().catch(() => "");
        const ge = groError("provider_error", `Anthropic API failed (${res.status}): ${text}`, {
          provider: "anthropic",
          model: resolvedModel,
          request_id: requestId,
          retryable: RETRYABLE_STATUS.has(res.status),
          cause: new Error(text),
        });
        Logger.error("Anthropic driver error:", errorLogFields(ge));
        throw ge;
      }

      const data = await res.json() as any;

      let text = "";
      const toolCalls: ChatToolCall[] = [];

      for (const block of data.content ?? []) {
        if (block.type === "text") {
          text += block.text;
          if (onToken) {
            try { onToken(block.text); } catch {}
          }
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "custom",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        }
      }

      return { text, toolCalls };
    } catch (e: unknown) {
      if (isGroError(e)) throw e; // already wrapped above
      const ge = groError("provider_error", `Anthropic driver error: ${asError(e).message}`, {
        provider: "anthropic",
        model: resolvedModel,
        request_id: requestId,
        retryable: false,
        cause: e,
      });
      Logger.error("Anthropic driver error:", errorLogFields(ge));
      throw ge;
    }
  }

  return { chat };
}

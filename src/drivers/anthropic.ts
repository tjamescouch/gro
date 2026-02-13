/**
 * Anthropic Messages API driver.
 * Direct HTTP — no SDK dependency.
 */
import { Logger } from "../logger.js";
import { rateLimiter } from "../utils/rate-limiter.js";
import { timedFetch } from "../utils/timed-fetch.js";
import { groError, asError, isGroError, errorLogFields } from "../errors.js";
import type { ChatDriver, ChatMessage, ChatOutput, ChatToolCall } from "./types.js";

export interface AnthropicDriverConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
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

    // Separate system messages from conversation
    let systemPrompt: string | undefined;
    const apiMessages: { role: string; content: string }[] = [];

    for (const m of messages) {
      if (m.role === "system") {
        systemPrompt = systemPrompt ? systemPrompt + "\n" + m.content : m.content;
      } else {
        apiMessages.push({ role: m.role, content: m.content });
      }
    }

    const body: any = {
      model: resolvedModel,
      max_tokens: maxTokens,
      messages: apiMessages,
    };
    if (systemPrompt) body.system = systemPrompt;

    // Tools support
    if (Array.isArray(opts?.tools) && opts.tools.length) {
      body.tools = opts.tools;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    };

    const RETRYABLE_STATUS = new Set([429, 503, 529]);
    let requestId: string | undefined;

    try {
      const res = await timedFetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        where: "driver:anthropic",
        timeoutMs,
      });

      requestId = res.headers.get("request-id") ?? undefined;

      if (!res.ok) {
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
            type: "function",
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

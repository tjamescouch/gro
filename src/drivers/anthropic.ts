/**
 * Anthropic Messages API driver with SSE streaming support.
 * Direct HTTP — no SDK dependency.
 */
import { Logger } from "../logger.js";
import { rateLimiter } from "../utils/rate-limiter.js";
import { timedFetch } from "../utils/timed-fetch.js";
import type { ChatDriver, ChatMessage, ChatOutput, ChatToolCall } from "./types.js";

export interface AnthropicDriverConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  baseUrl?: string;
}

export function makeAnthropicDriver(cfg: AnthropicDriverConfig): ChatDriver {
  const model = cfg.model ?? "claude-sonnet-4-20250514";
  const maxTokens = cfg.maxTokens ?? 4096;
  const defaultTimeout = cfg.timeoutMs ?? 2 * 60 * 60 * 1000;
  const base = (cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const endpoint = `${base}/v1/messages`;

  async function chat(messages: ChatMessage[], opts?: any): Promise<ChatOutput> {
    await rateLimiter.limit("llm-ask", 1);

    const onToken: ((t: string) => void) | undefined = opts?.onToken;
    const resolvedModel = opts?.model ?? model;

    // Separate system messages from conversation
    let systemPrompt: string | undefined;
    const apiMessages: { role: string; content: any }[] = [];

    for (const m of messages) {
      if (m.role === "system") {
        systemPrompt = systemPrompt ? systemPrompt + "\n" + m.content : m.content;
      } else if (m.role === "tool") {
        // Anthropic expects tool results as role "user" with tool_result content blocks
        apiMessages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: m.tool_call_id ?? "",
            content: m.content,
          }],
        });
      } else {
        apiMessages.push({ role: m.role, content: m.content });
      }
    }

    const body: any = {
      model: resolvedModel,
      max_tokens: maxTokens,
      messages: apiMessages,
      stream: true,
    };
    if (systemPrompt) body.system = systemPrompt;

    // Tools support — convert from OpenAI function-calling format to Anthropic format
    if (Array.isArray(opts?.tools) && opts.tools.length) {
      body.tools = opts.tools.map((t: any) => {
        const fn = t.function ?? t;
        return {
          name: fn.name,
          description: fn.description ?? "",
          input_schema: fn.parameters ?? { type: "object", properties: {} },
        };
      });
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    };

    const controller = new AbortController();
    const userSignal: AbortSignal | undefined = opts?.signal;
    const linkAbort = () => controller.abort();
    if (userSignal) {
      if (userSignal.aborted) controller.abort();
      else userSignal.addEventListener("abort", linkAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), defaultTimeout);

    try {
      const res = await timedFetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        where: "driver:anthropic:stream",
        timeoutMs: 0, // we manage our own timeout via the controller
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Anthropic API failed (${res.status}): ${text}`);
      }

      const ct = (res.headers.get("content-type") || "").toLowerCase();

      // Non-streaming fallback (some proxies may strip SSE)
      if (!ct.includes("text/event-stream")) {
        const data = await res.json() as any;
        return parseNonStreamResponse(data, onToken);
      }

      // SSE streaming
      return await parseStreamResponse(res, onToken);
    } catch (e: any) {
      if (e?.name === "AbortError") Logger.debug("timeout(anthropic-stream)", { ms: defaultTimeout });
      throw e;
    } finally {
      clearTimeout(timer);
      if (userSignal) userSignal.removeEventListener("abort", linkAbort);
    }
  }

  function parseNonStreamResponse(
    data: any,
    onToken?: (t: string) => void,
  ): ChatOutput {
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
  }

  async function parseStreamResponse(
    res: Response,
    onToken?: (t: string) => void,
  ): Promise<ChatOutput> {
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    let fullText = "";
    const toolBlocks = new Map<number, { id: string; name: string; args: string }>();

    const processEvent = (eventType: string, dataStr: string) => {
      if (!dataStr) return;
      let payload: any;
      try { payload = JSON.parse(dataStr); } catch { return; }

      switch (eventType) {
        case "content_block_start": {
          const idx: number = payload.index ?? 0;
          const block = payload.content_block;
          if (block?.type === "tool_use") {
            toolBlocks.set(idx, { id: block.id ?? "", name: block.name ?? "", args: "" });
          }
          break;
        }

        case "content_block_delta": {
          const idx: number = payload.index ?? 0;
          const delta = payload.delta;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            fullText += delta.text;
            if (onToken) {
              try { onToken(delta.text); } catch {}
            }
          } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const existing = toolBlocks.get(idx);
            if (existing) {
              existing.args += delta.partial_json;
            }
          }
          break;
        }

        case "message_stop":
        case "message_delta":
          break;
      }
    };

    const pumpRawEvent = (rawEvent: string) => {
      let eventType = "";
      const dataLines: string[] = [];

      for (const line of rawEvent.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("event:")) {
          eventType = trimmed.slice(6).trim();
        } else if (trimmed.startsWith("data:")) {
          dataLines.push(trimmed.slice(5).trim());
        }
      }

      if (dataLines.length > 0) {
        processEvent(eventType, dataLines.join("\n"));
      }
    };

    const body: any = res.body;

    if (body && typeof body.getReader === "function") {
      const reader = body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sepIdx: number;
        while ((sepIdx = buf.indexOf("\n\n")) !== -1) {
          const rawEvent = buf.slice(0, sepIdx).trim();
          buf = buf.slice(sepIdx + 2);
          if (rawEvent) pumpRawEvent(rawEvent);
        }
      }
      if (buf.trim()) pumpRawEvent(buf.trim());
    } else if (body && typeof body[Symbol.asyncIterator] === "function") {
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let sepIdx: number;
        while ((sepIdx = buf.indexOf("\n\n")) !== -1) {
          const rawEvent = buf.slice(0, sepIdx).trim();
          buf = buf.slice(sepIdx + 2);
          if (rawEvent) pumpRawEvent(rawEvent);
        }
      }
      if (buf.trim()) pumpRawEvent(buf.trim());
    } else {
      const txt = await res.text();
      for (const part of txt.split("\n\n").map(s => s.trim())) {
        if (part) pumpRawEvent(part);
      }
    }

    const toolCalls: ChatToolCall[] = Array.from(toolBlocks.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({
        id: v.id,
        type: "function" as const,
        function: { name: v.name, arguments: v.args },
      }));

    return { text: fullText, toolCalls };
  }

  return { chat };
}

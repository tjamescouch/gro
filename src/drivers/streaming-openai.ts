/**
 * Streaming OpenAI-compatible chat driver.
 * Works with OpenAI, Anthropic (via proxy), LM Studio, Ollama, etc.
 */
import { Logger } from "../logger.js";
import { asError } from "../errors.js";
import { rateLimiter } from "../utils/rate-limiter.js";
import { timedFetch } from "../utils/timed-fetch.js";
import { getMaxRetries, isRetryable, retryDelay, sleep } from "../utils/retry.js";
import type { ChatDriver, ChatMessage, ChatOutput, ChatToolCall, TokenUsage } from "./types.js";

export interface OpenAiDriverConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

function yieldToLoop(): Promise<void> {
  return new Promise<void>((resolve) =>
    typeof (globalThis as any).setImmediate === "function"
      ? (globalThis as any).setImmediate(resolve)
      : setTimeout(resolve, 0)
  );
}

class YieldBudget {
  private bytesSince = 0;
  private last = Date.now();
  constructor(
    private readonly byteBudget = 1024,
    private readonly msBudget = 8
  ) {}
  async maybe(extraBytes = 0): Promise<void> {
    this.bytesSince += extraBytes;
    const now = Date.now();
    if (this.bytesSince >= this.byteBudget || (now - this.last) >= this.msBudget) {
      this.bytesSince = 0;
      this.last = now;
      await yieldToLoop();
    }
  }
}

export function makeStreamingOpenAiDriver(cfg: OpenAiDriverConfig): ChatDriver {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const endpoint = `${base}/v1/chat/completions`;
  const defaultTimeout = cfg.timeoutMs ?? 2 * 60 * 60 * 1000;

  async function chat(messages: ChatMessage[], opts?: any): Promise<ChatOutput> {
    await rateLimiter.limit("llm-ask", 1);

    // Always log data size, full dump only in verbose+debug mode
    const payloadSize = JSON.stringify(messages).length;
    const sizeMB = (payloadSize / (1024 * 1024)).toFixed(2);

    // Extract snippet from last message for observability (shows what prompted this call)
    let snippet = "";
    const lastMsg = messages[messages.length - 1];
    if (lastMsg) {
      if (lastMsg.role === "tool" && lastMsg.name && lastMsg.content) {
        // Format tool messages as function calls: tool_name(key=val, ...)
        try {
          const toolData = JSON.parse(lastMsg.content);
          const args = Object.entries(toolData)
            .slice(0, 3) // Show first 3 keys
            .map(([k, v]) => {
              const valStr = typeof v === "string" ? v : JSON.stringify(v);
              const truncated = valStr.length > 30 ? valStr.slice(0, 30) + "..." : valStr;
              return `${k}=${JSON.stringify(truncated)}`;
            })
            .join(", ");
          snippet = `${lastMsg.name}(${args})`;
        } catch {
          // Fallback if not valid JSON
          const content = lastMsg.content.trim().replace(/\n+/g, " ");
          snippet = `${lastMsg.name}(${content.slice(0, 80)}...)`;
        }
      } else if (lastMsg.content) {
        // Regular message (user/assistant/etc): show content
        const content = lastMsg.content.trim().replace(/\n+/g, " ");
        snippet = content.length > 120 ? content.slice(0, 120) + "..." : content;
      }
    }

    Logger.info(`[API →] ${sizeMB} MB (${messages.length} messages)${snippet ? ` <${snippet}>` : ""}`);
    Logger.debug("streaming messages out", messages);

    const controller = new AbortController();
    const userSignal: AbortSignal | undefined = opts?.signal;
    const linkAbort = () => controller.abort();
    if (userSignal) {
      if (userSignal.aborted) controller.abort();
      else userSignal.addEventListener("abort", linkAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), defaultTimeout);

    const model = opts?.model ?? cfg.model;
    const tools = Array.isArray(opts?.tools) && opts.tools.length ? opts.tools : undefined;
    const onToken: ((t: string) => void) | undefined = opts?.onToken;
    const onReasoningToken: ((t: string) => void) | undefined = opts?.onReasoningToken;
    const onToolCallDelta: ((t: ChatToolCall) => void) | undefined = opts?.onToolCallDelta;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

    // Strip internal-only fields (from, tool_call_id on non-tool roles) before sending
    const stripped = messages.map(({ from: _from, ...m }) => m);

    // OpenAI requires strict tool_call/tool message pairing. Memory compaction can break this.
    // Fix both directions: orphaned tool messages AND orphaned tool_calls.
    const wireMessages: typeof stripped = [];
    for (let i = 0; i < stripped.length; i++) {
      const msg = stripped[i];

      // Case 1: Orphaned tool message (no preceding assistant with tool_calls)
      if (msg.role === "tool") {
        const prev = wireMessages[wireMessages.length - 1] as any;
        if (!prev || prev.role !== "assistant" || !prev.tool_calls || !prev.tool_calls.length) {
          // Insert placeholder assistant with dummy tool_call
          wireMessages.push({
            role: "assistant",
            content: "[context compressed — tool invocation truncated]",
            tool_calls: [{
              id: (msg as any).tool_call_id || "truncated",
              type: "function",
              function: { name: (msg as any).name || "unknown_tool", arguments: "{}" }
            }]
          } as any);
        }
      }

      wireMessages.push(msg);

      // Case 2: Orphaned tool_calls (assistant has tool_calls but responses were removed)
      if (msg.role === "assistant" && (msg as any).tool_calls && (msg as any).tool_calls.length > 0) {
        const calls = (msg as any).tool_calls as Array<{id: string; function: {name: string}}>;
        // Check if next message(s) are tool responses for these call IDs
        const nextMsgs = stripped.slice(i + 1);
        const respondedIds = new Set(
          nextMsgs.filter(m => m.role === "tool").map(m => (m as any).tool_call_id)
        );
        // Insert placeholder tool responses for missing IDs
        for (const call of calls) {
          if (!respondedIds.has(call.id)) {
            wireMessages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.function.name,
              content: "[context compressed — tool result truncated]"
            } as any);
          }
        }
      }
    }

    const payload: any = { model, messages: wireMessages, stream: true };
    if (tools) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }

    try {
      let res!: Response;
      for (let attempt = 0; ; attempt++) {
        res = await timedFetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
          where: "driver:openai:stream",
          timeoutMs: defaultTimeout,
        });

        if (res.ok) break;

        if (isRetryable(res.status) && attempt < getMaxRetries()) {
          const delay = retryDelay(attempt, res.headers.get("retry-after"));
          Logger.warn(`OpenAI ${res.status}, retry ${attempt + 1}/${getMaxRetries()} in ${Math.round(delay)}ms`);
          await sleep(delay);
          continue;
        }

        const text = await res.text().catch(() => "");
        throw new Error(`OpenAI chat (stream) failed (${res.status}): ${text}`);
      }

      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("text/event-stream")) {
        const data = await res.json().catch(() => ({}));
        const choice = data?.choices?.[0];
        const msg = choice?.message || {};
        const content = typeof msg?.content === "string" ? msg.content : "";
        const toolCalls: ChatToolCall[] = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
        if (content && onToken) onToken(content);
        const usage: TokenUsage | undefined = data?.usage ? {
          inputTokens: data.usage.prompt_tokens ?? 0,
          outputTokens: data.usage.completion_tokens ?? 0,
        } : undefined;

        // Log response size
        const responseSize = JSON.stringify({ text: content, toolCalls, usage }).length;
        const respMB = (responseSize / (1024 * 1024)).toFixed(2);
        Logger.info(`[API ←] ${respMB} MB`);

        return { text: content, reasoning: msg?.reasoning || undefined, toolCalls, usage };
      }

      // SSE streaming
      const decoder = new TextDecoder("utf-8");
      const yb = new YieldBudget(1024, 8);
      let buf = "";
      let fullText = "";
      let fullReasoning = "";
      let streamUsage: TokenUsage | undefined;
      const toolByIndex = new Map<number, ChatToolCall>();

      const pumpEvent = async (rawEvent: string) => {
        const dataLines = rawEvent
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.replace(/^data:\s?/, ""));

        if (!dataLines.length) return;
        const joined = dataLines.join("\n").trim();
        if (!joined || joined === "[DONE]") return;

        let payload: any;
        try { payload = JSON.parse(joined); } catch { return; }

        // Capture usage from final streaming chunk (if stream_options.include_usage was set)
        if (payload?.usage) {
          streamUsage = {
            inputTokens: payload.usage.prompt_tokens ?? 0,
            outputTokens: payload.usage.completion_tokens ?? 0,
          };
        }

        const delta = payload?.choices?.[0]?.delta;
        if (!delta) return;

        if (typeof delta.content === "string" && delta.content.length) {
          fullText += delta.content;
          if (onToken) {
            let s = delta.content;
            while (s.length) {
              const piece = s.slice(0, 512);
              s = s.slice(512);
              try { onToken(piece); } catch {}
              await yb.maybe(piece.length);
            }
          } else {
            await yb.maybe(delta.content.length);
          }
        }

        if (typeof delta.reasoning === "string" && delta.reasoning.length) {
          fullReasoning += delta.reasoning;
          if (onReasoningToken) {
            let s = delta.reasoning;
            while (s.length) {
              const piece = s.slice(0, 512);
              s = s.slice(512);
              try { onReasoningToken(piece); } catch {}
              await yb.maybe(piece.length);
            }
          } else {
            await yb.maybe(delta.reasoning.length);
          }
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const item of delta.tool_calls) {
            const idx: number = typeof item?.index === "number" ? item.index : 0;
            const prev = toolByIndex.get(idx) ?? {
              id: "", type: "function", function: { name: "", arguments: "" }
            };
            if (typeof item.id === "string" && item.id) prev.id = item.id;
            if (typeof item.type === "string" && item.type) (prev as any).type = item.type;
            const f = item?.function ?? {};
            if (typeof f.name === "string" && f.name) prev.function.name += f.name;
            if (typeof f.arguments === "string" && f.arguments) prev.function.arguments += f.arguments;
            toolByIndex.set(idx, prev);
            if (onToolCallDelta) {
              try { onToolCallDelta(prev); } catch {}
            }
            await yb.maybe(64);
          }
        }
      };

      const body: any = res.body;

      if (body && typeof body.getReader === "function") {
        const reader = body.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            await yb.maybe((value as Uint8Array)?.byteLength ?? 0);
            let sepIdx: number;
            while ((sepIdx = buf.indexOf("\n\n")) !== -1) {
              const rawEvent = buf.slice(0, sepIdx).trim();
              buf = buf.slice(sepIdx + 2);
              if (rawEvent) await pumpEvent(rawEvent);
            }
          }
          if (buf.trim()) await pumpEvent(buf.trim());
        } finally {
          reader.cancel().catch(() => {});
        }
      } else if (body && typeof body[Symbol.asyncIterator] === "function") {
        for await (const chunk of body as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true });
          await yb.maybe(chunk.byteLength);
          let sepIdx: number;
          while ((sepIdx = buf.indexOf("\n\n")) !== -1) {
            const rawEvent = buf.slice(0, sepIdx).trim();
            buf = buf.slice(sepIdx + 2);
            if (rawEvent) await pumpEvent(rawEvent);
          }
        }
        if (buf.trim()) await pumpEvent(buf.trim());
      } else {
        const txt = await res.text();
        for (const part of txt.split("\n\n").map((s) => s.trim())) {
          if (part) await pumpEvent(part);
        }
      }

      const toolCalls: ChatToolCall[] = Array.from(toolByIndex.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v);

      // Log response size
      const responseSize = JSON.stringify({ text: fullText, toolCalls, usage: streamUsage }).length;
      const respMB = (responseSize / (1024 * 1024)).toFixed(2);
      Logger.info(`[API ←] ${respMB} MB`);

      return { text: fullText, reasoning: fullReasoning || undefined, toolCalls, usage: streamUsage };
    } catch (e: unknown) {
      const wrapped = asError(e);
      if (wrapped.name === "AbortError") Logger.debug("timeout(stream)", { ms: defaultTimeout });
      throw wrapped;
    } finally {
      clearTimeout(timer);
      if (userSignal) userSignal.removeEventListener("abort", linkAbort);
    }
  }

  return { chat };
}

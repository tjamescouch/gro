/**
 * Streaming OpenAI-compatible chat driver.
 * Works with OpenAI, Anthropic (via proxy), LM Studio, Ollama, etc.
 */
import { Logger } from "../logger.js";
import { rateLimiter } from "../utils/rate-limiter.js";
import { timedFetch } from "../utils/timed-fetch.js";
import type { ChatDriver, ChatMessage, ChatOutput, ChatToolCall } from "./types.js";

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

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

function isRetryable(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 529;
}

function retryDelay(attempt: number): number {
  const base = RETRY_BASE_MS * Math.pow(2, attempt);
  const jitter = Math.random() * base * 0.5;
  return base + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function makeStreamingOpenAiDriver(cfg: OpenAiDriverConfig): ChatDriver {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const endpoint = `${base}/v1/chat/completions`;
  const defaultTimeout = cfg.timeoutMs ?? 2 * 60 * 60 * 1000;

  async function chat(messages: ChatMessage[], opts?: any): Promise<ChatOutput> {
    await rateLimiter.limit("llm-ask", 1);
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

    const payload: any = { model, messages, stream: true };
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

        if (isRetryable(res.status) && attempt < MAX_RETRIES) {
          const delay = retryDelay(attempt);
          Logger.warn(`OpenAI ${res.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delay)}ms`);
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
        return { text: content, reasoning: msg?.reasoning || undefined, toolCalls };
      }

      // SSE streaming
      const decoder = new TextDecoder("utf-8");
      const yb = new YieldBudget(1024, 8);
      let buf = "";
      let fullText = "";
      let fullReasoning = "";
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

      return { text: fullText, reasoning: fullReasoning || undefined, toolCalls };
    } catch (e: any) {
      if (e?.name === "AbortError") Logger.debug("timeout(stream)", { ms: defaultTimeout });
      throw e;
    } finally {
      clearTimeout(timer);
      if (userSignal) userSignal.removeEventListener("abort", linkAbort);
    }
  }

  return { chat };
}

/**
 * Streaming Google Gemini chat driver.
 * Native Gemini API — not the OpenAI compatibility shim.
 *
 * Endpoint: POST /v1beta/models/{model}:streamGenerateContent?alt=sse
 * Auth: x-goog-api-key header
 * Message format: contents[] with role (user/model) and parts[{text}]
 * Tool format: tools[{functionDeclarations}]
 */
import { Logger, C } from "../logger.js";
import { spendMeter } from "../spend-meter.js";
import { asError } from "../errors.js";
import { rateLimiter } from "../utils/rate-limiter.js";
import { timedFetch } from "../utils/timed-fetch.js";
import { getMaxRetries, isRetryable, retryDelay, sleep } from "../utils/retry.js";
import type { ChatDriver, ChatMessage, ChatOutput, ChatToolCall, TokenUsage } from "./types.js";

export interface GoogleDriverConfig {
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

// --- Message conversion ---

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, any> };
  functionResponse?: { name: string; response: Record<string, any> };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/**
 * Convert gro ChatMessage[] to Gemini contents[] + systemInstruction.
 *
 * Gemini differences from OpenAI:
 *   - role "assistant" → "model"
 *   - role "system" (first) → systemInstruction (separate field)
 *   - role "tool" → user turn with functionResponse part
 *   - tool_calls in assistant → model turn with functionCall parts
 *   - Gemini requires alternating user/model turns (merge consecutive same-role)
 */
function convertMessages(messages: ChatMessage[]): {
  systemInstruction: GeminiContent | undefined;
  contents: GeminiContent[];
} {
  let systemInstruction: GeminiContent | undefined;
  const raw: GeminiContent[] = [];

  for (const msg of messages) {
    // System prompt → systemInstruction (only first one)
    if (msg.role === "system") {
      if (!systemInstruction) {
        systemInstruction = { role: "user", parts: [{ text: msg.content }] };
      }
      // Additional system messages get folded into user turns
      else if (msg.content) {
        raw.push({ role: "user", parts: [{ text: `[System: ${msg.content}]` }] });
      }
      continue;
    }

    // Tool result → user turn with functionResponse
    if (msg.role === "tool") {
      let responseData: Record<string, any>;
      try {
        responseData = JSON.parse(msg.content);
      } catch {
        responseData = { result: msg.content };
      }
      raw.push({
        role: "user",
        parts: [{
          functionResponse: {
            name: msg.name || "unknown_tool",
            response: responseData,
          }
        }]
      });
      continue;
    }

    // Assistant with tool_calls → model turn with functionCall parts
    if (msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (msg.content) {
        parts.push({ text: msg.content });
      }
      const toolCalls = (msg as any).tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          let args: Record<string, any> = {};
          try {
            args = JSON.parse(tc.function?.arguments || "{}");
          } catch { /* empty */ }
          parts.push({
            functionCall: {
              name: tc.function?.name || "unknown",
              args,
            }
          });
        }
      }
      if (parts.length > 0) {
        raw.push({ role: "model", parts });
      }
      continue;
    }

    // User message
    if (msg.role === "user") {
      raw.push({ role: "user", parts: [{ text: msg.content || "" }] });
      continue;
    }

    // Fallback: treat unknown roles as user
    if (msg.content) {
      raw.push({ role: "user", parts: [{ text: msg.content }] });
    }
  }

  // Gemini requires alternating user/model turns — merge consecutive same-role
  const merged: GeminiContent[] = [];
  for (const turn of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === turn.role) {
      prev.parts.push(...turn.parts);
    } else {
      merged.push({ ...turn, parts: [...turn.parts] });
    }
  }

  // Gemini requires conversation to start with user turn
  if (merged.length > 0 && merged[0].role === "model") {
    merged.unshift({ role: "user", parts: [{ text: "(conversation continues)" }] });
  }

  return { systemInstruction, contents: merged };
}

/**
 * Convert gro tools to Gemini functionDeclarations format.
 */
function convertTools(tools: any[]): any[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  const declarations = tools.map((t: any) => {
    const name = t.function?.name ?? t.name ?? "unknown";
    const description = t.function?.description ?? t.description ?? "";
    const parameters = t.function?.parameters ?? t.inputSchema ?? t.input_schema ?? t.parameters ?? { type: "object", properties: {} };
    return { name, description, parameters };
  });

  return [{ functionDeclarations: declarations }];
}

// --- Driver ---

export function makeGoogleDriver(cfg: GoogleDriverConfig): ChatDriver {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const defaultTimeout = cfg.timeoutMs ?? 2 * 60 * 60 * 1000;

  async function chat(messages: ChatMessage[], opts?: any): Promise<ChatOutput> {
    await rateLimiter.limit("llm-ask", 1);

    const model = opts?.model ?? cfg.model;
    const endpoint = `${base}/v1beta/models/${model}:streamGenerateContent?alt=sse`;

    // Logging
    const payloadSize = JSON.stringify(messages).length;
    const sizeMB = (payloadSize / (1024 * 1024)).toFixed(2);

    let snippet = "";
    const lastMsg = messages[messages.length - 1];
    if (lastMsg) {
      if (lastMsg.role === "tool" && lastMsg.name && lastMsg.content) {
        try {
          const toolData = JSON.parse(lastMsg.content);
          const args = Object.entries(toolData)
            .slice(0, 3)
            .map(([k, v]) => {
              const valStr = typeof v === "string" ? v : JSON.stringify(v);
              const truncated = valStr.length > 30 ? valStr.slice(0, 30) + "..." : valStr;
              return `${k}=${JSON.stringify(truncated)}`;
            })
            .join(", ");
          snippet = `${lastMsg.name}(${args})`;
        } catch {
          const content = lastMsg.content.trim().replace(/\n+/g, " ");
          snippet = `${lastMsg.name}(${content.slice(0, 80)}...)`;
        }
      } else if (lastMsg.content) {
        const content = lastMsg.content.trim().replace(/\n+/g, " ");
        snippet = content.length > 120 ? content.slice(0, 120) + "..." : content;
      }
    }
    Logger.telemetry(`[API →] ${sizeMB} MB (${messages.length} messages)${snippet ? ` <${snippet}>` : ""}`);

    const controller = new AbortController();
    const userSignal: AbortSignal | undefined = opts?.signal;
    const linkAbort = () => controller.abort();
    if (userSignal) {
      if (userSignal.aborted) controller.abort();
      else userSignal.addEventListener("abort", linkAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), defaultTimeout);

    const tools = Array.isArray(opts?.tools) && opts.tools.length ? opts.tools : undefined;
    const onToken: ((t: string) => void) | undefined = opts?.onToken;
    const onReasoningToken: ((t: string) => void) | undefined = opts?.onReasoningToken;
    const onToolCallDelta: ((t: ChatToolCall) => void) | undefined = opts?.onToolCallDelta;

    // Convert messages and tools to Gemini format
    const { systemInstruction, contents } = convertMessages(messages);
    const geminiTools = convertTools(tools);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (cfg.apiKey) {
      headers["x-goog-api-key"] = cfg.apiKey;
    }

    const payload: any = { contents };

    if (systemInstruction) {
      payload.systemInstruction = systemInstruction;
    }

    if (geminiTools) {
      payload.tools = geminiTools;
    }

    // Generation config — clamped to Google ranges
    const generationConfig: any = {};
    if (opts?.temperature !== undefined) generationConfig.temperature = Math.max(0, Math.min(2, opts.temperature));
    if (opts?.top_p !== undefined) generationConfig.topP = Math.max(0, Math.min(1, opts.top_p));
    if (opts?.top_k !== undefined) generationConfig.topK = Math.max(1, Math.round(opts.top_k));
    if (Object.keys(generationConfig).length > 0) {
      payload.generationConfig = generationConfig;
    }

    try {
      let res!: Response;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await timedFetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
            where: "driver:google:stream",
            timeoutMs: defaultTimeout,
          });
        } catch (fetchErr: unknown) {
          if (attempt < getMaxRetries()) {
            const delay = retryDelay(attempt);
            Logger.warn(`Google fetch error: ${asError(fetchErr).message}, retry ${attempt + 1}/${getMaxRetries()} in ${Math.round(delay)}ms`);
            await sleep(delay);
            continue;
          }
          throw fetchErr;
        }

        if (res.ok) break;

        if (isRetryable(res.status) && attempt < getMaxRetries()) {
          const delay = retryDelay(attempt, res.headers.get("retry-after"));
          Logger.warn(`Google ${res.status}, retry ${attempt + 1}/${getMaxRetries()} in ${Math.round(delay)}ms`);
          await sleep(delay);
          continue;
        }

        const text = await res.text().catch(() => "");
        throw new Error(`Google chat (stream) failed (${res.status}): ${text}`);
      }

      const ct = (res.headers.get("content-type") || "").toLowerCase();

      // Non-streaming fallback
      if (!ct.includes("text/event-stream")) {
        const data = await res.json().catch(() => ({}));
        const candidate = data?.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];

        let content = "";
        const toolCalls: ChatToolCall[] = [];

        for (const part of parts) {
          if (part.text) content += part.text;
          if (part.functionCall) {
            toolCalls.push({
              id: `call_${Math.random().toString(36).slice(2, 10)}`,
              type: "function",
              function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args ?? {}),
              }
            });
          }
        }

        if (content && onToken) onToken(content);

        const usage: TokenUsage | undefined = data?.usageMetadata ? {
          inputTokens: data.usageMetadata.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
        } : undefined;

        const responseSize = JSON.stringify({ text: content, toolCalls, usage }).length;
        const respMB = (responseSize / (1024 * 1024)).toFixed(2);
        let costInfo = "";
        if (usage) {
          spendMeter.record(usage.inputTokens, usage.outputTokens);
          const reqCost = spendMeter.lastRequestCost;
          const sessCost = spendMeter.cost();
          const color = reqCost < 0.01 ? C.green : reqCost < 0.05 ? C.yellow : C.red;
          costInfo = ` ${color(`[$${reqCost.toFixed(4)} / $${sessCost.toFixed(4)}]`)}`;
        }
        Logger.telemetry(`[API ←] ${respMB} MB${costInfo}`);

        return { text: content, toolCalls, usage };
      }

      // SSE streaming
      const decoder = new TextDecoder("utf-8");
      const yb = new YieldBudget(1024, 8);
      let buf = "";
      let fullText = "";
      let fullReasoning = "";
      let streamUsage: TokenUsage | undefined;
      const toolCallsAccum: ChatToolCall[] = [];

      const pumpEvent = async (rawEvent: string) => {
        const dataLines = rawEvent
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.replace(/^data:\s?/, ""));

        if (!dataLines.length) return;
        const joined = dataLines.join("\n").trim();
        if (!joined || joined === "[DONE]") return;

        let data: any;
        try { data = JSON.parse(joined); } catch { return; }

        // Usage metadata
        if (data?.usageMetadata) {
          streamUsage = {
            inputTokens: data.usageMetadata.promptTokenCount ?? 0,
            outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
          };
        }

        const parts = data?.candidates?.[0]?.content?.parts;
        if (!Array.isArray(parts)) return;

        for (const part of parts) {
          // Text content
          if (typeof part.text === "string" && part.text.length) {
            fullText += part.text;
            if (onToken) {
              let s = part.text;
              while (s.length) {
                const piece = s.slice(0, 512);
                s = s.slice(512);
                try { onToken(piece); } catch {}
                await yb.maybe(piece.length);
              }
            } else {
              await yb.maybe(part.text.length);
            }
          }

          // Thinking/reasoning (Gemini 2.5+ "thought" field)
          if (typeof part.thought === "string" && part.thought.length) {
            fullReasoning += part.thought;
            if (onReasoningToken) {
              let s = part.thought;
              while (s.length) {
                const piece = s.slice(0, 512);
                s = s.slice(512);
                try { onReasoningToken(piece); } catch {}
                await yb.maybe(piece.length);
              }
            }
          }

          // Function calls
          if (part.functionCall) {
            const tc: ChatToolCall = {
              id: `call_${Math.random().toString(36).slice(2, 10)}`,
              type: "function",
              function: {
                name: part.functionCall.name || "",
                arguments: JSON.stringify(part.functionCall.args ?? {}),
              }
            };
            toolCallsAccum.push(tc);
            if (onToolCallDelta) {
              try { onToolCallDelta(tc); } catch {}
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

      // Log response
      const responseSize = JSON.stringify({ text: fullText, toolCalls: toolCallsAccum, usage: streamUsage }).length;
      const respMB = (responseSize / (1024 * 1024)).toFixed(2);
      let costInfo = "";
      if (streamUsage) {
        spendMeter.record(streamUsage.inputTokens, streamUsage.outputTokens);
        const reqCost = spendMeter.lastRequestCost;
        const sessCost = spendMeter.cost();
        const color = reqCost < 0.01 ? C.green : reqCost < 0.05 ? C.yellow : C.red;
        costInfo = ` ${color(`[$${reqCost.toFixed(4)} / $${sessCost.toFixed(4)}]`)}`;
      }
      Logger.telemetry(`[API ←] ${respMB} MB${costInfo}`);

      return {
        text: fullText,
        reasoning: fullReasoning || undefined,
        toolCalls: toolCallsAccum,
        usage: streamUsage,
      };
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

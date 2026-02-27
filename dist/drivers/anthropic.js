/**
 * Anthropic Messages API driver.
 * Direct HTTP — no SDK dependency.
 */
import { Logger, C } from "../logger.js";
import { spendMeter } from "../spend-meter.js";
import { rateLimiter } from "../utils/rate-limiter.js";
import { timedFetch } from "../utils/timed-fetch.js";
import { getMaxRetries, isRetryable, retryDelay, sleep } from "../utils/retry.js";
import { groError, asError, isGroError, errorLogFields } from "../errors.js";
function yieldToLoop() {
    return new Promise((resolve) => typeof globalThis.setImmediate === "function"
        ? globalThis.setImmediate(resolve)
        : setTimeout(resolve, 0));
}
class YieldBudget {
    constructor(byteBudget = 1024, msBudget = 8) {
        this.byteBudget = byteBudget;
        this.msBudget = msBudget;
        this.bytesSince = 0;
        this.last = Date.now();
    }
    async maybe(extraBytes = 0) {
        this.bytesSince += extraBytes;
        const now = Date.now();
        if (this.bytesSince >= this.byteBudget || (now - this.last) >= this.msBudget) {
            this.bytesSince = 0;
            this.last = now;
            await yieldToLoop();
        }
    }
}
/**
 * Convert tool definitions from OpenAI format to Anthropic format.
 * OpenAI: { type: "function", function: { name, description, parameters } }
 * Anthropic: { name, description, input_schema }
 */
function convertToolDefs(tools) {
    return tools.map(t => {
        if (t.type === "function" && t.function) {
            return {
                type: "custom",
                name: t.function.name,
                description: t.function.description || "",
                input_schema: t.function.parameters || { type: "object", properties: {} },
            };
        }
        // Already in Anthropic format — ensure type is set
        if (!t.type)
            return { type: "custom", ...t };
        return t;
    });
}
function convertMessages(messages) {
    const systemBlocks = [];
    const apiMessages = [];
    // Pre-scan: collect all tool_use IDs and all tool_result IDs for cross-referencing.
    // This lets us drop orphaned tool_results (missing tool_use) AND orphaned tool_uses
    // (missing tool_result) — both cause Anthropic API 400 errors.
    const knownToolUseIds = new Set();
    const knownToolResultIds = new Set();
    const answeredToolUseIds = new Set();
    for (const m of messages) {
        if (m.role === "assistant") {
            const toolCalls = m.tool_calls;
            if (Array.isArray(toolCalls)) {
                for (const tc of toolCalls) {
                    if (tc.id)
                        knownToolUseIds.add(tc.id);
                }
            }
        }
        if (m.role === "tool" && m.tool_call_id) {
            knownToolResultIds.add(m.tool_call_id);
        }
    }
    for (const m of messages) {
        if (m.role === "system") {
            // Preserve system messages as separate blocks with source metadata
            // so the caller can apply cache_control breakpoints per-block.
            const source = m.from || "System";
            // Merge consecutive blocks from the same source
            const last = systemBlocks[systemBlocks.length - 1];
            if (last && last.source === source) {
                last.text += "\n" + m.content;
            }
            else {
                systemBlocks.push({ text: m.content, source });
            }
            continue;
        }
        if (m.role === "assistant") {
            const content = [];
            if (m.content)
                content.push({ type: "text", text: m.content });
            // Convert OpenAI-style tool_calls to Anthropic tool_use blocks,
            // but only include tool_calls that have matching tool_results
            const toolCalls = m.tool_calls;
            if (Array.isArray(toolCalls)) {
                const orphanedIds = [];
                for (const tc of toolCalls) {
                    if (tc.id && !knownToolResultIds.has(tc.id)) {
                        orphanedIds.push(tc.id);
                        continue; // Skip this tool_use — no matching tool_result exists
                    }
                    let input;
                    try {
                        input = JSON.parse(tc.function.arguments || "{}");
                    }
                    catch {
                        input = {};
                    }
                    content.push({
                        type: "tool_use",
                        id: tc.id,
                        name: tc.function.name,
                        input,
                    });
                }
                if (orphanedIds.length > 0) {
                    Logger.warn(`Dropping ${orphanedIds.length} orphaned tool_use(s) without tool_results: ${orphanedIds.join(", ")}`);
                }
            }
            if (content.length > 0) {
                apiMessages.push({ role: "assistant", content });
            }
            continue;
        }
        if (m.role === "tool") {
            // Skip orphaned tool_results — their tool_use was truncated from history
            if (m.tool_call_id && !knownToolUseIds.has(m.tool_call_id)) {
                Logger.debug(`Dropping orphaned tool_result for missing tool_use id=${m.tool_call_id}`);
                continue;
            }
            // Skip duplicate tool_results — can arise from session reload or memory merging
            if (m.tool_call_id && answeredToolUseIds.has(m.tool_call_id)) {
                Logger.debug(`Dropping duplicate tool_result for tool_use id=${m.tool_call_id}`);
                continue;
            }
            if (m.tool_call_id)
                answeredToolUseIds.add(m.tool_call_id);
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
            }
            else {
                apiMessages.push({ role: "user", content: [block] });
            }
            continue;
        }
        // Regular user messages
        apiMessages.push({ role: "user", content: m.content });
    }
    // Final validation: ensure every tool_use is immediately followed by its tool_result.
    // After VM compaction, messages can be reordered (summaries injected, concurrent adds)
    // such that a tool_result exists but is NOT immediately after its tool_use — causing
    // Anthropic API 400: "tool_use ids found without tool_result blocks immediately after".
    for (let i = apiMessages.length - 1; i >= 0; i--) {
        const msg = apiMessages[i];
        if (msg.role !== "assistant" || !Array.isArray(msg.content))
            continue;
        const toolUseBlocks = msg.content.filter((b) => b.type === "tool_use");
        if (toolUseBlocks.length === 0)
            continue;
        // Collect tool_result IDs from the immediately following message
        const next = apiMessages[i + 1];
        const immediateResultIds = new Set();
        if (next && next.role === "user" && Array.isArray(next.content)) {
            for (const b of next.content) {
                if (b.type === "tool_result" && b.tool_use_id) {
                    immediateResultIds.add(b.tool_use_id);
                }
            }
        }
        // Strip tool_use blocks whose results aren't immediately following
        const orphaned = toolUseBlocks.filter((b) => !immediateResultIds.has(b.id));
        if (orphaned.length > 0) {
            Logger.warn(`Stripping ${orphaned.length} tool_use(s) without immediate tool_result: ${orphaned.map((b) => b.id).join(", ")}`);
            const orphanedIds = new Set(orphaned.map((b) => b.id));
            msg.content = msg.content.filter((b) => b.type !== "tool_use" || !orphanedIds.has(b.id));
            // If assistant message is now empty, remove it
            if (msg.content.length === 0) {
                apiMessages.splice(i, 1);
            }
        }
    }
    // Second pass: remove orphaned tool_result blocks (their tool_use was stripped above).
    // Rebuild the set of surviving tool_use IDs.
    const survivingToolUseIds = new Set();
    for (const msg of apiMessages) {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (const b of msg.content) {
                if (b.type === "tool_use" && b.id)
                    survivingToolUseIds.add(b.id);
            }
        }
    }
    for (let i = apiMessages.length - 1; i >= 0; i--) {
        const msg = apiMessages[i];
        if (msg.role !== "user" || !Array.isArray(msg.content))
            continue;
        const hasToolResults = msg.content.some((b) => b.type === "tool_result");
        if (!hasToolResults)
            continue;
        msg.content = msg.content.filter((b) => b.type !== "tool_result" || survivingToolUseIds.has(b.tool_use_id));
        // If user message is now empty, remove it
        if (msg.content.length === 0) {
            apiMessages.splice(i, 1);
        }
    }
    return { systemBlocks, apiMessages };
}
/** Pattern matching transient network errors that should be retried */
const TRANSIENT_ERROR_RE = /fetch timeout|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|socket hang up/i;
/** Parse response content blocks into text + tool calls + token usage */
function parseResponseContent(data, onToken, onReasoningToken) {
    let text = "";
    let reasoning = "";
    const toolCalls = [];
    for (const block of data.content ?? []) {
        if (block.type === "thinking" && block.thinking) {
            reasoning += block.thinking;
            if (onReasoningToken) {
                try {
                    onReasoningToken(block.thinking);
                }
                catch { }
            }
        }
        else if (block.type === "text") {
            text += block.text;
            if (onToken) {
                try {
                    onToken(block.text);
                }
                catch { }
            }
        }
        else if (block.type === "tool_use") {
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
    const usage = data.usage ? {
        inputTokens: data.usage.input_tokens ?? 0,
        outputTokens: data.usage.output_tokens ?? 0,
        cacheCreationInputTokens: data.usage.cache_creation_input_tokens,
        cacheReadInputTokens: data.usage.cache_read_input_tokens,
    } : undefined;
    // Log response size and cache stats
    const responseSize = JSON.stringify({ text, toolCalls, usage }).length;
    const respMB = (responseSize / (1024 * 1024)).toFixed(2);
    let cacheInfo = "";
    if (usage?.cacheCreationInputTokens || usage?.cacheReadInputTokens) {
        const parts = [];
        if (usage.cacheCreationInputTokens)
            parts.push(`write:${usage.cacheCreationInputTokens}`);
        if (usage.cacheReadInputTokens)
            parts.push(C.green(`read:${usage.cacheReadInputTokens}`));
        cacheInfo = ` ${C.cyan(`[cache ${parts.join(", ")}]`)}`;
    }
    let costInfo = "";
    if (usage) {
        spendMeter.record(usage.inputTokens, usage.outputTokens, usage.cacheCreationInputTokens, usage.cacheReadInputTokens);
        const reqCost = spendMeter.lastRequestCost;
        const sessCost = spendMeter.cost();
        const color = reqCost < 0.01 ? C.green : reqCost < 0.05 ? C.yellow : C.red;
        costInfo = ` ${color(`[$${reqCost.toFixed(4)} / $${sessCost.toFixed(4)}]`)}`;
    }
    Logger.telemetry(`${C.blue("[API ←]")} ${respMB} MB${cacheInfo}${costInfo}`);
    return { text, toolCalls, reasoning: reasoning || undefined, usage };
}
/**
 * Determine if a model supports Anthropic adaptive/extended thinking.
 * Conservative allowlist approach: if we don't recognize the model,
 * we omit thinking (safe default — API works fine without it).
 */
function supportsAdaptiveThinking(model) {
    const m = model.toLowerCase();
    // Opus 4.x — supports thinking
    if (/claude-opus-4/.test(m))
        return true;
    // Sonnet 4 dated builds (e.g. claude-sonnet-4-20250514) — supports thinking
    // Sonnet 4.5 (claude-sonnet-4-5) does NOT support adaptive thinking
    if (/claude-sonnet-4-\d{8}/.test(m))
        return true;
    // Claude 3.7 Sonnet — supports thinking
    if (/claude-3[.-]7/.test(m))
        return true;
    // Claude 3.5 Sonnet (Oct 2024) — supports thinking
    if (/claude-3[.-]5-sonnet.*20241022/.test(m))
        return true;
    return false;
}
export function makeAnthropicDriver(cfg) {
    const base = (cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    const endpoint = `${base}/v1/messages`;
    const model = cfg.model ?? "claude-sonnet-4-20250514";
    const maxTokens = cfg.maxTokens ?? 4096;
    const timeoutMs = cfg.timeoutMs ?? 2 * 60 * 60 * 1000;
    const enablePromptCaching = cfg.enablePromptCaching ?? true;
    async function chat(messages, opts) {
        await rateLimiter.limit("llm-ask", 1);
        const onToken = opts?.onToken;
        const onReasoningToken = opts?.onReasoningToken;
        const onToolCallDelta = opts?.onToolCallDelta;
        const resolvedModel = opts?.model ?? model;
        const { systemBlocks, apiMessages } = convertMessages(messages);
        // Guard: if all non-system messages were dropped (e.g. orphaned tool_results),
        // inject a minimal user message so the API call doesn't fail with "at least one message required"
        if (apiMessages.length === 0) {
            Logger.warn("All messages were filtered during conversion — injecting fallback user message");
            apiMessages.push({ role: "user", content: "(continue)" });
        }
        // Guard: conversation must end with a user message (Anthropic rejects assistant-prefill).
        // After compaction + orphan stripping, the last message can be an assistant message
        // (e.g. all its tool_use blocks were stripped, leaving only text).
        const lastApiMsg = apiMessages[apiMessages.length - 1];
        if (lastApiMsg && lastApiMsg.role === "assistant") {
            // Check if we're in a (continue) loop: if recent messages alternate between
            // (continue) user messages and thin assistant responses, we're in a death spiral.
            let continueCount = 0;
            for (let i = apiMessages.length - 1; i >= Math.max(0, apiMessages.length - 10); i--) {
                const m = apiMessages[i];
                if (m.role === "user" && m.content === "(continue)")
                    continueCount++;
            }
            if (continueCount >= 3) {
                Logger.warn("Detected (continue) loop — stripping trailing assistant message instead of appending another continuation");
                apiMessages.pop();
            }
            else {
                Logger.debug("Conversation ends with assistant message after conversion — appending user continuation");
                apiMessages.push({ role: "user", content: "(continue)" });
            }
        }
        const thinkingBudget = opts?.thinkingBudget ?? 0;
        // Reserve 30% of max_tokens for completion output, allocate 70% to thinking budget.
        // E.g., maxTokens=4096, thinkingBudget=0.8 → thinking gets ~2293 tokens, output ~1803
        const thinkingConfig = thinkingBudget > 0
            ? { type: "enabled", budget_tokens: Math.round(maxTokens * Math.min(1, thinkingBudget) * 0.7) }
            : { type: "disabled" };
        const body = {
            model: resolvedModel,
            max_tokens: maxTokens,
            messages: apiMessages,
            stream: true,
        };
        // Apply thinking config: explicit budget takes priority, else adaptive if supported
        if (thinkingBudget > 0) {
            body.thinking = thinkingConfig;
        }
        else if (supportsAdaptiveThinking(resolvedModel)) {
            body.thinking = { type: "adaptive" };
        }
        // Sampling parameters (optional runtime overrides)
        if (opts?.temperature !== undefined)
            body.temperature = opts.temperature;
        if (opts?.top_k !== undefined)
            body.top_k = opts.top_k;
        if (opts?.top_p !== undefined)
            body.top_p = opts.top_p;
        // System prompt: build from structured blocks with per-block cache breakpoints.
        // Order: System (stable) → VirtualMemory (loaded pages) → SensoryMemory (sensory buffer)
        // Anthropic allows max 4 cache_control blocks total. Tools uses 1, so system gets at most 3.
        if (systemBlocks.length > 0) {
            if (enablePromptCaching) {
                // Sort blocks: System first, then VirtualMemory (pages), then SensoryMemory, then others
                const ORDER = { System: 0, VirtualMemory: 1, SensoryMemory: 2 };
                const sorted = [...systemBlocks].sort((a, b) => (ORDER[a.source] ?? 1.5) - (ORDER[b.source] ?? 1.5));
                // Anthropic max 4 cache_control blocks; reserve 1 for tools → 3 for system.
                // If more than 3 system blocks, only the first 3 get cache_control.
                const MAX_CACHED_SYSTEM_BLOCKS = 3;
                body.system = sorted.map((block, i) => {
                    const entry = {
                        type: "text",
                        text: block.text,
                    };
                    if (i < MAX_CACHED_SYSTEM_BLOCKS) {
                        entry.cache_control = { type: "ephemeral" };
                    }
                    return entry;
                });
            }
            else {
                // No caching: concatenate into a single string (legacy behavior)
                body.system = systemBlocks.map(b => b.text).join("\n");
            }
        }
        // Tools support — convert from OpenAI format to Anthropic format
        if (Array.isArray(opts?.tools) && opts.tools.length) {
            body.tools = convertToolDefs(opts.tools);
            // Prompt caching: add cache_control to the last tool definition
            if (enablePromptCaching) {
                body.tools[body.tools.length - 1].cache_control = { type: "ephemeral" };
            }
        }
        const headers = {
            "Content-Type": "application/json",
            "x-api-key": cfg.apiKey,
            "anthropic-version": "2023-06-01",
        };
        // Prompt caching requires anthropic-beta header
        if (enablePromptCaching) {
            headers["anthropic-beta"] = "prompt-caching-2024-07-31";
        }
        // Always log data size
        const payloadSize = JSON.stringify(body).length;
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
                }
                catch {
                    // Fallback if not valid JSON
                    const content = lastMsg.content.trim().replace(/\n+/g, " ");
                    snippet = `${lastMsg.name}(${content.slice(0, 80)}...)`;
                }
            }
            else if (lastMsg.content) {
                // Regular message (user/assistant/etc): show content
                const content = lastMsg.content.trim().replace(/\n+/g, " ");
                snippet = content.length > 120 ? content.slice(0, 120) + "..." : content;
            }
        }
        Logger.telemetry(`${C.yellow("[API →]")} ${sizeMB} MB (${messages.length} messages)${snippet ? C.gray(` <${snippet}>`) : ""}`);
        // AbortController + timeout (matches OpenAI driver pattern)
        const controller = new AbortController();
        const userSignal = opts?.signal;
        const linkAbort = () => controller.abort();
        if (userSignal) {
            if (userSignal.aborted)
                controller.abort();
            else
                userSignal.addEventListener("abort", linkAbort, { once: true });
        }
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const RETRYABLE_STATUS = new Set([429, 503, 529]);
        let requestId;
        try {
            let res;
            for (let attempt = 0;; attempt++) {
                try {
                    res = await timedFetch(endpoint, {
                        method: "POST",
                        headers,
                        body: JSON.stringify(body),
                        signal: controller.signal,
                        where: "driver:anthropic",
                        timeoutMs,
                    });
                }
                catch (fetchErr) {
                    if (attempt < getMaxRetries()) {
                        const delay = retryDelay(attempt);
                        Logger.warn(`Anthropic fetch error: ${asError(fetchErr).message}, retry ${attempt + 1}/${getMaxRetries()} in ${Math.round(delay)}ms`);
                        await sleep(delay);
                        continue;
                    }
                    throw fetchErr;
                }
                if (res.ok)
                    break;
                if (isRetryable(res.status) && attempt < getMaxRetries()) {
                    const delay = retryDelay(attempt, res.headers.get("retry-after"));
                    Logger.warn(`Anthropic ${res.status}, retry ${attempt + 1}/${getMaxRetries()} in ${Math.round(delay)}ms`);
                    await sleep(delay);
                    continue;
                }
                const text = await res.text().catch(() => "");
                // If 400 due to thinking not supported, retry without thinking params
                if (res.status === 400 && body.thinking && /thinking|not supported/i.test(text)) {
                    Logger.warn(`Model ${resolvedModel} rejected adaptive thinking — retrying without`);
                    delete body.thinking;
                    continue;
                }
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
            // Non-streaming fallback: if Content-Type is not SSE, parse as JSON
            const ct = (res.headers.get("content-type") || "").toLowerCase();
            if (!ct.includes("text/event-stream")) {
                const data = await res.json();
                return parseResponseContent(data, onToken, onReasoningToken);
            }
            // --- SSE streaming ---
            const decoder = new TextDecoder("utf-8");
            const yb = new YieldBudget(1024, 8);
            let buf = "";
            let fullText = "";
            let fullReasoning = "";
            let streamUsage;
            const toolByIndex = new Map();
            const pumpEvent = async (rawEvent) => {
                // Parse SSE event: extract `event:` type and `data:` payload
                let eventType = "";
                const dataLines = [];
                for (const line of rawEvent.split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith("event:")) {
                        eventType = trimmed.slice(6).trim();
                    }
                    else if (trimmed.startsWith("data:")) {
                        dataLines.push(trimmed.slice(5).trim());
                    }
                }
                if (!dataLines.length)
                    return;
                const joined = dataLines.join("\n").trim();
                if (!joined)
                    return;
                let payload;
                try {
                    payload = JSON.parse(joined);
                }
                catch {
                    return;
                }
                const type = payload?.type || eventType;
                if (type === "message_start") {
                    // Extract initial usage (input_tokens, cache stats)
                    const usage = payload?.message?.usage;
                    if (usage) {
                        streamUsage = {
                            inputTokens: usage.input_tokens ?? 0,
                            outputTokens: usage.output_tokens ?? 0,
                            cacheCreationInputTokens: usage.cache_creation_input_tokens,
                            cacheReadInputTokens: usage.cache_read_input_tokens,
                        };
                    }
                    return;
                }
                if (type === "content_block_start") {
                    const idx = payload?.index ?? 0;
                    const block = payload?.content_block;
                    if (block?.type === "tool_use") {
                        toolByIndex.set(idx, { id: block.id ?? "", name: block.name ?? "", args: "" });
                    }
                    return;
                }
                if (type === "content_block_delta") {
                    const delta = payload?.delta;
                    if (!delta)
                        return;
                    if (delta.type === "text_delta" && typeof delta.text === "string") {
                        fullText += delta.text;
                        if (onToken) {
                            let s = delta.text;
                            while (s.length) {
                                const piece = s.slice(0, 512);
                                s = s.slice(512);
                                try {
                                    onToken(piece);
                                }
                                catch { }
                                await yb.maybe(piece.length);
                            }
                        }
                        else {
                            await yb.maybe(delta.text.length);
                        }
                    }
                    else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
                        fullReasoning += delta.thinking;
                        if (onReasoningToken) {
                            let s = delta.thinking;
                            while (s.length) {
                                const piece = s.slice(0, 512);
                                s = s.slice(512);
                                try {
                                    onReasoningToken(piece);
                                }
                                catch { }
                                await yb.maybe(piece.length);
                            }
                        }
                        else {
                            await yb.maybe(delta.thinking.length);
                        }
                    }
                    else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                        const idx = payload?.index ?? 0;
                        const tool = toolByIndex.get(idx);
                        if (tool) {
                            tool.args += delta.partial_json;
                            if (onToolCallDelta) {
                                try {
                                    onToolCallDelta({
                                        id: tool.id,
                                        type: "custom",
                                        function: { name: tool.name, arguments: tool.args },
                                    });
                                }
                                catch { }
                            }
                            await yb.maybe(delta.partial_json.length);
                        }
                    }
                    return;
                }
                if (type === "message_delta") {
                    // Extract final output usage (output_tokens)
                    const usage = payload?.usage;
                    if (usage && streamUsage) {
                        streamUsage.outputTokens = usage.output_tokens ?? streamUsage.outputTokens;
                    }
                    return;
                }
                // content_block_stop, message_stop, ping — no action needed
            };
            const resBody = res.body;
            if (resBody && typeof resBody.getReader === "function") {
                const reader = resBody.getReader();
                try {
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done)
                            break;
                        buf += decoder.decode(value, { stream: true });
                        await yb.maybe(value?.byteLength ?? 0);
                        let sepIdx;
                        while ((sepIdx = buf.indexOf("\n\n")) !== -1) {
                            const rawEvent = buf.slice(0, sepIdx).trim();
                            buf = buf.slice(sepIdx + 2);
                            if (rawEvent)
                                await pumpEvent(rawEvent);
                        }
                    }
                    if (buf.trim())
                        await pumpEvent(buf.trim());
                }
                finally {
                    reader.cancel().catch(() => { });
                }
            }
            else if (resBody && typeof resBody[Symbol.asyncIterator] === "function") {
                for await (const chunk of resBody) {
                    buf += decoder.decode(chunk, { stream: true });
                    await yb.maybe(chunk.byteLength);
                    let sepIdx;
                    while ((sepIdx = buf.indexOf("\n\n")) !== -1) {
                        const rawEvent = buf.slice(0, sepIdx).trim();
                        buf = buf.slice(sepIdx + 2);
                        if (rawEvent)
                            await pumpEvent(rawEvent);
                    }
                }
                if (buf.trim())
                    await pumpEvent(buf.trim());
            }
            else {
                const txt = await res.text();
                for (const part of txt.split("\n\n").map((s) => s.trim())) {
                    if (part)
                        await pumpEvent(part);
                }
            }
            // Build tool calls from accumulated data
            const toolCalls = Array.from(toolByIndex.entries())
                .sort((a, b) => a[0] - b[0])
                .map(([, v]) => {
                // Parse accumulated JSON args (or default to "{}")
                let argsStr = v.args || "{}";
                try {
                    JSON.parse(argsStr);
                }
                catch {
                    argsStr = "{}";
                }
                return {
                    id: v.id,
                    type: "custom",
                    function: { name: v.name, arguments: argsStr },
                };
            });
            // Log response size and cache stats
            const responseSize = JSON.stringify({ text: fullText, toolCalls, usage: streamUsage }).length;
            const respMB = (responseSize / (1024 * 1024)).toFixed(2);
            let cacheInfo = "";
            if (streamUsage?.cacheCreationInputTokens || streamUsage?.cacheReadInputTokens) {
                const parts = [];
                if (streamUsage.cacheCreationInputTokens)
                    parts.push(`write:${streamUsage.cacheCreationInputTokens}`);
                if (streamUsage.cacheReadInputTokens)
                    parts.push(C.green(`read:${streamUsage.cacheReadInputTokens}`));
                cacheInfo = ` ${C.cyan(`[cache ${parts.join(", ")}]`)}`;
            }
            let costInfo = "";
            if (streamUsage) {
                spendMeter.record(streamUsage.inputTokens, streamUsage.outputTokens, streamUsage.cacheCreationInputTokens, streamUsage.cacheReadInputTokens);
                const reqCost = spendMeter.lastRequestCost;
                const sessCost = spendMeter.cost();
                const color = reqCost < 0.01 ? C.green : reqCost < 0.05 ? C.yellow : C.red;
                costInfo = ` ${color(`[$${reqCost.toFixed(4)} / $${sessCost.toFixed(4)}]`)}`;
            }
            Logger.telemetry(`${C.blue("[API ←]")} ${respMB} MB${cacheInfo}${costInfo}`);
            return { text: fullText, toolCalls, reasoning: fullReasoning || undefined, usage: streamUsage };
        }
        catch (e) {
            if (isGroError(e))
                throw e; // already wrapped above
            // Classify the error: fetch timeouts and network errors are transient
            const errMsg = asError(e).message;
            const isTransient = TRANSIENT_ERROR_RE.test(errMsg);
            if (isTransient) {
                // Retry transient network errors (e.g. auth proxy down during container restart)
                for (let attempt = 0; attempt < getMaxRetries(); attempt++) {
                    const delay = retryDelay(attempt);
                    Logger.warn(`Transient error: ${errMsg.substring(0, 120)}, retry ${attempt + 1}/${getMaxRetries()} in ${Math.round(delay)}ms`);
                    await sleep(delay);
                    try {
                        const retryRes = await timedFetch(endpoint, {
                            method: "POST",
                            headers,
                            body: JSON.stringify(body),
                            signal: controller.signal,
                            where: "driver:anthropic",
                            timeoutMs,
                        });
                        if (!retryRes.ok) {
                            const text = await retryRes.text().catch(() => "");
                            if (isRetryable(retryRes.status) && attempt < getMaxRetries() - 1)
                                continue;
                            throw groError("provider_error", `Anthropic API failed (${retryRes.status}): ${text}`, {
                                provider: "anthropic", model: resolvedModel, retryable: false, cause: new Error(text),
                            });
                        }
                        // Success on retry — parse and return
                        const data = await retryRes.json();
                        Logger.info(`Recovered from transient error after ${attempt + 1} retries`);
                        return parseResponseContent(data, onToken);
                    }
                    catch (retryErr) {
                        if (isGroError(retryErr))
                            throw retryErr;
                        if (attempt === getMaxRetries() - 1) {
                            // Exhausted retries — throw with context
                            const ge = groError("provider_error", `Anthropic driver error (after ${getMaxRetries()} retries): ${errMsg}`, {
                                provider: "anthropic", model: resolvedModel, request_id: requestId,
                                retryable: false, cause: e,
                            });
                            Logger.error("Anthropic driver error (retries exhausted):", errorLogFields(ge));
                            throw ge;
                        }
                    }
                }
            }
            // Non-transient error — throw immediately
            const ge = groError("provider_error", `Anthropic driver error: ${errMsg}`, {
                provider: "anthropic",
                model: resolvedModel,
                request_id: requestId,
                retryable: false,
                cause: e,
            });
            Logger.error("Anthropic driver error:", errorLogFields(ge));
            throw ge;
        }
        finally {
            clearTimeout(timer);
            if (userSignal)
                userSignal.removeEventListener("abort", linkAbort);
        }
    }
    return { chat };
}

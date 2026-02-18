/**
 * Anthropic Messages API driver.
 * Direct HTTP — no SDK dependency.
 */
import { Logger } from "../logger.js";
import { rateLimiter } from "../utils/rate-limiter.js";
import { timedFetch } from "../utils/timed-fetch.js";
import { MAX_RETRIES, isRetryable, retryDelay, sleep } from "../utils/retry.js";
import { groError, asError, isGroError, errorLogFields } from "../errors.js";
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
/**
 * Convert internal messages (OpenAI-style) to Anthropic Messages API format.
 *
 * Key differences:
 * - Assistant tool calls become content blocks with type "tool_use"
 * - Tool result messages become user messages with type "tool_result" content blocks
 * - Anthropic requires strictly alternating user/assistant roles
 */
function convertMessages(messages) {
    let systemPrompt;
    const apiMessages = [];
    // Pre-scan: collect all tool_use IDs so we can drop orphaned tool_results
    // (happens when virtual-memory truncation drops the assistant tool_use message
    //  but keeps the tool_result that follows it — Anthropic rejects with 400)
    const knownToolUseIds = new Set();
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
    }
    for (const m of messages) {
        if (m.role === "system") {
            systemPrompt = systemPrompt ? systemPrompt + "\n" + m.content : m.content;
            continue;
        }
        if (m.role === "assistant") {
            const content = [];
            if (m.content)
                content.push({ type: "text", text: m.content });
            // Convert OpenAI-style tool_calls to Anthropic tool_use blocks
            const toolCalls = m.tool_calls;
            if (Array.isArray(toolCalls)) {
                for (const tc of toolCalls) {
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
            }
            if (content.length > 0) {
                apiMessages.push({ role: "assistant", content });
            }
            continue;
        }
        if (m.role === "tool") {
            // Skip orphaned tool_results — their tool_use was truncated from history
            if (m.tool_call_id && !knownToolUseIds.has(m.tool_call_id)) {
                Logger.warn(`Dropping orphaned tool_result for missing tool_use id=${m.tool_call_id}`);
                continue;
            }
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
    return { system: systemPrompt, apiMessages };
}
/** Pattern matching transient network errors that should be retried */
const TRANSIENT_ERROR_RE = /fetch timeout|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|socket hang up/i;
/** Parse response content blocks into text + tool calls + token usage */
function parseResponseContent(data, onToken) {
    let text = "";
    const toolCalls = [];
    for (const block of data.content ?? []) {
        if (block.type === "text") {
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
            parts.push(`read:${usage.cacheReadInputTokens}`);
        cacheInfo = ` [cache ${parts.join(", ")}]`;
    }
    Logger.info(`[API ←] ${respMB} MB${cacheInfo}`);
    return { text, toolCalls, usage };
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
        const resolvedModel = opts?.model ?? model;
        const { system: systemPrompt, apiMessages } = convertMessages(messages);
        const body = {
            model: resolvedModel,
            max_tokens: maxTokens,
            messages: apiMessages,
        };
        // Only include adaptive thinking for models that support it
        if (supportsAdaptiveThinking(resolvedModel)) {
            body.thinking = { type: "adaptive" };
        }
        // Prompt caching: wrap system prompt in content block with cache_control
        if (systemPrompt) {
            if (enablePromptCaching) {
                body.system = [{
                        type: "text",
                        text: systemPrompt,
                        cache_control: { type: "ephemeral" }
                    }];
            }
            else {
                body.system = systemPrompt;
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
        Logger.info(`[API →] ${sizeMB} MB (${messages.length} messages)${snippet ? ` <${snippet}>` : ""}`);
        const RETRYABLE_STATUS = new Set([429, 503, 529]);
        let requestId;
        try {
            let res;
            for (let attempt = 0;; attempt++) {
                res = await timedFetch(endpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(body),
                    where: "driver:anthropic",
                    timeoutMs,
                });
                if (res.ok)
                    break;
                if (isRetryable(res.status) && attempt < MAX_RETRIES) {
                    const delay = retryDelay(attempt);
                    Logger.warn(`Anthropic ${res.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delay)}ms`);
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
            const data = await res.json();
            return parseResponseContent(data, onToken);
        }
        catch (e) {
            if (isGroError(e))
                throw e; // already wrapped above
            // Classify the error: fetch timeouts and network errors are transient
            const errMsg = asError(e).message;
            const isTransient = TRANSIENT_ERROR_RE.test(errMsg);
            if (isTransient) {
                // Retry transient network errors (e.g. auth proxy down during container restart)
                for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                    const delay = retryDelay(attempt);
                    Logger.warn(`Transient error: ${errMsg.substring(0, 120)}, retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delay)}ms`);
                    await sleep(delay);
                    try {
                        const retryRes = await timedFetch(endpoint, {
                            method: "POST",
                            headers,
                            body: JSON.stringify(body),
                            where: "driver:anthropic",
                            timeoutMs,
                        });
                        if (!retryRes.ok) {
                            const text = await retryRes.text().catch(() => "");
                            if (isRetryable(retryRes.status) && attempt < MAX_RETRIES - 1)
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
                        if (attempt === MAX_RETRIES - 1) {
                            // Exhausted retries — throw with context
                            const ge = groError("provider_error", `Anthropic driver error (after ${MAX_RETRIES} retries): ${errMsg}`, {
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
    }
    return { chat };
}

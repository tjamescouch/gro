import { AgentMemory } from "../agent-memory.js";
import { saveSession, loadSession, ensureGroDir } from "../../session.js";
/**
 * AdvancedMemory — swim-lane summarization with token budgeting.
 *
 * Maintains three lanes (assistant / system / user) and summarizes independently.
 * Uses character-based token estimation with high/low watermark hysteresis.
 * Background summarization never blocks the caller.
 */
export class AdvancedMemory extends AgentMemory {
    constructor(args) {
        super(args.systemPrompt);
        this.provider = "unknown";
        this.driver = args.driver;
        this.model = args.model;
        this.summarizerDriver = args.summarizerDriver ?? args.driver;
        this.summarizerModel = args.summarizerModel ?? args.model;
        this.contextTokens = Math.max(2048, Math.floor(args.contextTokens ?? 8192));
        this.reserveHeaderTokens = Math.max(0, Math.floor(args.reserveHeaderTokens ?? 1200));
        this.reserveResponseTokens = Math.max(0, Math.floor(args.reserveResponseTokens ?? 800));
        this.highRatio = Math.min(0.95, Math.max(0.55, args.highRatio ?? 0.70));
        this.lowRatio = Math.min(this.highRatio - 0.05, Math.max(0.35, args.lowRatio ?? 0.50));
        this.summaryRatio = Math.min(0.50, Math.max(0.15, args.summaryRatio ?? 0.35));
        this.avgCharsPerToken = Math.max(1.5, Number(args.avgCharsPerToken ?? 2.8));
        this.keepRecentPerLane = Math.max(1, Math.floor(args.keepRecentPerLane ?? 4));
        this.keepRecentTools = Math.max(0, Math.floor(args.keepRecentTools ?? 3));
    }
    setProvider(provider) {
        this.provider = provider;
    }
    setModel(model) {
        this.model = model;
    }
    async load(id) {
        const session = loadSession(id);
        if (session) {
            this.messagesBuffer = session.messages;
        }
    }
    async save(id) {
        ensureGroDir();
        saveSession(id, this.messagesBuffer, {
            id,
            provider: this.provider,
            model: this.model,
            createdAt: new Date().toISOString(),
        });
    }
    /**
     * Return messages for the API, with hard truncation as a safety net.
     * Even if background summarization hasn't caught up, this ensures we never
     * send more than the configured context budget to the driver.
     */
    messages() {
        const budget = this.budgetTokens();
        const all = [...this.messagesBuffer];
        const estTok = this.estimateTokens(all);
        // If under budget, return everything (common case)
        if (estTok <= budget)
            return all;
        // Hard truncation: keep system prompt + most recent messages that fit
        const result = [];
        let usedTok = 0;
        // Always keep the system prompt (first message if system role)
        if (all.length > 0 && all[0].role === "system") {
            result.push(all[0]);
            usedTok = this.estimateTokens(result);
        }
        // Walk backwards from the end, adding messages until we hit budget.
        // Tool call/result pairs must be kept together: if we include a tool_result,
        // its preceding assistant tool_use must also be included (and vice versa).
        const toAdd = [];
        const minIdx = result.length > 0 ? 1 : 0;
        for (let i = all.length - 1; i >= minIdx; i--) {
            // Collect tool pair: if this is a tool result, grab all consecutive tool results
            // AND the preceding assistant message (which has the tool_calls)
            let group = [all[i]];
            if (all[i].role === "tool") {
                // Walk back to include all consecutive tool results and the assistant before them
                let j = i - 1;
                while (j >= minIdx && all[j].role === "tool") {
                    group.unshift(all[j]);
                    j--;
                }
                // Include the assistant message with tool_calls
                if (j >= minIdx && all[j].role === "assistant") {
                    group.unshift(all[j]);
                }
                i = j + 1; // skip past the group on next iteration
            }
            const candidate = [...group, ...toAdd];
            const candidateTok = this.estimateTokens(candidate);
            if (usedTok + candidateTok <= budget) {
                toAdd.unshift(...group);
            }
            else {
                break; // No more room
            }
        }
        return [...result, ...toAdd];
    }
    async onAfterAdd() {
        const budget = this.budgetTokens();
        const estTok = this.estimateTokens(this.messagesBuffer);
        if (estTok <= Math.floor(this.highRatio * budget))
            return;
        await this.runOnce(async () => {
            const budget2 = this.budgetTokens();
            const estTok2 = this.estimateTokens(this.messagesBuffer);
            if (estTok2 <= Math.floor(this.highRatio * budget2))
                return;
            const { firstSystemIndex, assistant, user, system, tool, other } = this.partition();
            const tailN = this.keepRecentPerLane;
            const olderAssistant = assistant.slice(0, Math.max(0, assistant.length - tailN));
            const keepAssistant = assistant.slice(Math.max(0, assistant.length - tailN));
            const sysHead = firstSystemIndex === 0 ? [this.messagesBuffer[0]] : [];
            const remainingSystem = firstSystemIndex === 0 ? system.slice(1) : system.slice(0);
            const olderSystem = remainingSystem.slice(0, Math.max(0, remainingSystem.length - tailN));
            const keepSystem = remainingSystem.slice(Math.max(0, remainingSystem.length - tailN));
            const olderUser = user.slice(0, Math.max(0, user.length - tailN));
            const keepUser = user.slice(Math.max(0, user.length - tailN));
            const keepTools = tool.slice(Math.max(0, tool.length - this.keepRecentTools));
            const preserved = [
                ...sysHead, ...keepAssistant, ...keepSystem, ...keepUser, ...keepTools, ...other,
            ];
            const preservedTok = this.estimateTokens(preserved);
            const lowTarget = Math.floor(this.lowRatio * budget2);
            const maxSummaryTok = Math.floor(this.summaryRatio * budget2);
            if (preservedTok <= lowTarget) {
                const rebuilt = this.ordered([], sysHead, keepAssistant, keepSystem, keepUser, keepTools, other);
                this.messagesBuffer.splice(0, this.messagesBuffer.length, ...rebuilt);
                return;
            }
            const removedCharA = this.totalChars(olderAssistant);
            const removedCharS = this.totalChars(olderSystem);
            const removedCharU = this.totalChars(olderUser);
            const removedTotal = Math.max(1, removedCharA + removedCharS + removedCharU);
            const totalSummaryBudget = Math.max(64, Math.min(maxSummaryTok, lowTarget - preservedTok));
            const budgetA = Math.max(48, Math.floor(totalSummaryBudget * (removedCharA / removedTotal)));
            const budgetS = Math.max(48, Math.floor(totalSummaryBudget * (removedCharS / removedTotal)));
            const budgetU = Math.max(48, Math.floor(totalSummaryBudget * (removedCharU / removedTotal)));
            const [sumA, sumS, sumU] = await Promise.all([
                olderAssistant.length ? this.summarizeLane("assistant", olderAssistant, budgetA) : "",
                olderSystem.length ? this.summarizeLane("system", olderSystem, budgetS) : "",
                olderUser.length ? this.summarizeLane("user", olderUser, budgetU) : "",
            ]);
            const summaries = [];
            if (sumA)
                summaries.push({ from: "Me", role: "assistant", content: `ASSISTANT SUMMARY:\n${sumA}` });
            if (sumS)
                summaries.push({ from: "System", role: "system", content: `SYSTEM SUMMARY:\n${sumS}` });
            if (sumU)
                summaries.push({ from: "Memory", role: "user", content: `USER SUMMARY:\n${sumU}` });
            const rebuilt = this.ordered(summaries, sysHead, keepAssistant, keepSystem, keepUser, keepTools, other);
            this.messagesBuffer.splice(0, this.messagesBuffer.length, ...rebuilt);
            // Final clamp — preserve tool call/result pairs as atomic units
            let finalTok = this.estimateTokens(this.messagesBuffer);
            if (finalTok > lowTarget) {
                const pruned = [];
                const buf = this.messagesBuffer;
                for (let i = 0; i < buf.length; i++) {
                    const m = buf[i];
                    // Check if this assistant message has tool_calls — if so, treat it + subsequent tool results as a group
                    const tc = m.tool_calls;
                    if (m.role === "assistant" && Array.isArray(tc) && tc.length > 0) {
                        const group = [m];
                        let j = i + 1;
                        while (j < buf.length && buf[j].role === "tool") {
                            group.push(buf[j]);
                            j++;
                        }
                        // Either include the whole group or skip it entirely
                        pruned.push(...group);
                        finalTok = this.estimateTokens(pruned);
                        if (finalTok > lowTarget) {
                            // Remove the entire group
                            pruned.splice(pruned.length - group.length, group.length);
                        }
                        i = j - 1; // skip past tool results
                    }
                    else {
                        pruned.push(m);
                        finalTok = this.estimateTokens(pruned);
                        if (finalTok > lowTarget && m.role !== "system") {
                            pruned.pop();
                        }
                    }
                }
                this.messagesBuffer.splice(0, this.messagesBuffer.length, ...pruned);
            }
        });
    }
    budgetTokens() {
        return Math.max(512, this.contextTokens - this.reserveHeaderTokens - this.reserveResponseTokens);
    }
    estimateTokens(msgs) {
        return Math.ceil(this.totalChars(msgs) / this.avgCharsPerToken);
    }
    totalChars(msgs) {
        let c = 0;
        for (const m of msgs) {
            const s = String(m.content ?? "");
            if (m.role === "tool" && s.length > 24_000)
                c += 24_000;
            else
                c += s.length;
            c += 32;
        }
        return c;
    }
    partition() {
        const assistant = [];
        const user = [];
        const system = [];
        const tool = [];
        const other = [];
        for (const m of this.messagesBuffer) {
            switch (m.role) {
                case "assistant":
                    assistant.push(m);
                    break;
                case "user":
                    user.push(m);
                    break;
                case "system":
                    system.push(m);
                    break;
                case "tool":
                    tool.push(m);
                    break;
                default:
                    other.push(m);
                    break;
            }
        }
        const firstSystemIndex = this.messagesBuffer.findIndex(x => x.role === "system");
        return { firstSystemIndex, assistant, user, system, tool, other };
    }
    ordered(summaries, sysHead, keepA, keepS, keepU, keepT, other) {
        const keepSet = new Set([...sysHead, ...keepA, ...keepS, ...keepU, ...keepT, ...other]);
        const rest = [];
        for (const m of this.messagesBuffer) {
            if (keepSet.has(m))
                rest.push(m);
        }
        const orderedSummaries = [
            ...summaries.filter(s => s.role === "assistant"),
            ...summaries.filter(s => s.role === "system"),
            ...summaries.filter(s => s.role === "user"),
        ];
        return [...orderedSummaries, ...rest];
    }
    async summarizeLane(laneName, messages, tokenBudget) {
        if (messages.length === 0 || tokenBudget <= 0)
            return "";
        const approxChars = Math.max(120, Math.floor(tokenBudget * this.avgCharsPerToken));
        const header = (() => {
            switch (laneName) {
                case "assistant": return "Summarize prior ASSISTANT replies (decisions, plans, code edits, shell commands and outcomes).";
                case "system": return "Summarize SYSTEM instructions (rules, goals, constraints) without changing their intent.";
                case "user": return "Summarize USER requests, feedback, constraints, and acceptance criteria.";
            }
        })();
        let acc = "";
        for (const m of messages) {
            let c = String(m.content ?? "");
            if (c.length > 4000)
                c = c.slice(0, 4000) + "\n…(truncated)…";
            const next = `- ${laneName.toUpperCase()}: ${c}\n\n`;
            if (acc.length + next.length > approxChars * 3)
                break;
            acc += next;
        }
        const sys = {
            role: "system",
            from: "System",
            content: [
                "You are a precise summarizer.",
                "Output concise bullet points; preserve facts, tasks, file paths, commands, constraints.",
                `Hard limit: ~${approxChars} characters total.`,
                "Avoid fluff; keep actionable details.",
            ].join(" "),
        };
        const usr = {
            role: "user",
            from: "User",
            content: `${header}\n\nTranscript:\n${acc}`,
        };
        const out = await this.summarizerDriver.chat([sys, usr], { model: this.summarizerModel });
        return String(out?.text ?? "").trim();
    }
}

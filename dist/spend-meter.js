import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { C } from "./logger.js";
// Pricing per million tokens (input / output) in USD
const PRICING = {
    // Anthropic
    "claude-haiku-4-5": { in: 0.80, out: 4.00, cacheWrite: 1.00, cacheRead: 0.08 },
    "claude-haiku-4-5-20251001": { in: 0.80, out: 4.00, cacheWrite: 1.00, cacheRead: 0.08 },
    "claude-sonnet-4-5": { in: 3.00, out: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
    "claude-sonnet-4-5-20250929": { in: 3.00, out: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
    "claude-sonnet-4-20250514": { in: 3.00, out: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
    "claude-opus-4-6": { in: 15.00, out: 75.00, cacheWrite: 18.75, cacheRead: 1.50 },
    // OpenAI
    "gpt-4o": { in: 5.00, out: 15.00 },
    "gpt-4o-mini": { in: 0.15, out: 0.60 },
    "gpt-4-turbo": { in: 10.00, out: 30.00 },
    "o1": { in: 15.00, out: 60.00 },
    "o3-mini": { in: 1.10, out: 4.40 },
    "gpt-5-nano": { in: 0.05, out: 0.40 },
    "gpt-5-mini": { in: 0.25, out: 2.00 },
    "gpt-4.1-nano": { in: 0.10, out: 0.40 },
    "gpt-4.1-mini": { in: 0.40, out: 1.60 },
    "gpt-4.1": { in: 2.00, out: 8.00 },
    "gpt-5.2-codex": { in: 1.25, out: 10.00 },
    "gpt-5.2": { in: 1.75, out: 14.00 },
    "o3": { in: 2.00, out: 8.00 },
    "o4-mini": { in: 1.10, out: 4.40 },
    // Google
    "gemini-2.5-flash-lite": { in: 0.10, out: 0.40 },
    "gemini-2.5-flash": { in: 0.15, out: 0.60 },
    "gemini-2.5-pro": { in: 1.25, out: 10.00 },
    "gemini-3-flash": { in: 0.50, out: 3.00 },
    "gemini-3-pro": { in: 2.00, out: 12.00 },
    // xAI
    "grok-4-fast-reasoning": { in: 0.20, out: 0.50 },
    "grok-4-0709": { in: 3.00, out: 15.00 },
    // Local (free)
    "llama3": { in: 0.00, out: 0.00 },
    "qwen": { in: 0.00, out: 0.00 },
    "deepseek": { in: 0.00, out: 0.00 },
    // Groq
    "llama-3.3-70b-versatile": { in: 0.59, out: 0.79 },
    "llama-3.1-70b-versatile": { in: 0.59, out: 0.79 },
    "llama-3.1-8b-instant": { in: 0.05, out: 0.08 },
    "llama3-70b-8192": { in: 0.59, out: 0.79 },
    "llama3-8b-8192": { in: 0.05, out: 0.08 },
    "gemma2-9b-it": { in: 0.20, out: 0.20 },
    "mixtral-8x7b-32768": { in: 0.24, out: 0.24 },
};
const DEFAULT_PRICING = { in: 3.00, out: 15.00 }; // sonnet fallback
const POST_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const AGENTCHAT_SERVER = process.env.AGENTCHAT_SERVER ?? "ws://localhost:6667";
const AGENTCHAT_CHANNEL = process.env.AGENTCHAT_SPEND_CHANNEL ?? "#spend";
function findIdentity() {
    const candidates = [
        process.env.AGENTCHAT_IDENTITY,
        join(process.cwd(), ".agentchat", "identities", "gro.json"),
        join(homedir(), ".agentchat", "identities", "gro.json"),
    ];
    for (const p of candidates) {
        if (p && existsSync(p))
            return p;
    }
    // Last resort: first identity found in cwd .agentchat dir
    const dir = join(process.cwd(), ".agentchat", "identities");
    if (existsSync(dir)) {
        const files = readdirSync(dir).filter(f => f.endsWith(".json"));
        if (files.length)
            return join(dir, files[0]);
    }
    return null;
}
function priceFor(model) {
    if (PRICING[model])
        return PRICING[model];
    // Fuzzy match prefix (e.g. "claude-haiku" matches "claude-haiku-4-5")
    for (const [key, val] of Object.entries(PRICING)) {
        if (model.startsWith(key) || key.startsWith(model))
            return val;
    }
    return DEFAULT_PRICING;
}
export class SpendMeter {
    constructor() {
        this.startMs = null;
        this.totalIn = 0;
        this.totalOut = 0;
        this.totalCacheWrite = 0;
        this.totalCacheRead = 0;
        this._lastRequestCost = 0;
        this.model = "";
        this.lastPostMs = null;
        this.lastCumulativeCost = 0;
        // Turn timing
        this._turnStartMs = 0;
        this._lastTurnMs = 0;
        this._longestTurnMs = 0;
        this._totalTurnMs = 0;
        this._totalTurns = 0;
        // Tool horizon tracking
        this._turnToolCalls = 0;
        this._maxHorizon = 0;
    }
    setModel(model) { this.model = model; }
    record(inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens) {
        if (this.startMs === null)
            this.startMs = Date.now();
        const prevCost = this.cost();
        this.totalIn += inputTokens;
        this.totalOut += outputTokens;
        this.totalCacheWrite += cacheWriteTokens ?? 0;
        this.totalCacheRead += cacheReadTokens ?? 0;
        this._lastRequestCost = this.cost() - prevCost;
        this.maybePostToChat();
    }
    get lastRequestCost() { return this._lastRequestCost; }
    /** Check if cost exceeds a budget limit. Returns error message if exceeded, null if OK. */
    checkBudget(maxUsd) {
        if (!maxUsd || maxUsd <= 0)
            return null;
        const currentCost = this.cost();
        if (currentCost > maxUsd) {
            return `Budget exceeded: $${currentCost.toFixed(4)} > $${maxUsd.toFixed(4)}`;
        }
        return null;
    }
    maybePostToChat() {
        const now = Date.now();
        const due = this.lastPostMs === null || (now - this.lastPostMs) >= POST_INTERVAL_MS;
        if (!due)
            return;
        this.lastPostMs = now;
        const identity = findIdentity();
        if (!identity)
            return;
        const cumulativeCost = this.cost();
        const turnCost = cumulativeCost - this.lastCumulativeCost;
        this.lastCumulativeCost = cumulativeCost;
        const hrs = this.elapsedHours();
        const perHour = hrs > 0 ? cumulativeCost / hrs : 0;
        const tokTotal = this.totalIn + this.totalOut;
        const tokPerHr = hrs > 0 ? tokTotal / hrs : 0;
        const msg = [
            `💸 [${this.model || "unknown"}]`,
            `  turn:       $${turnCost.toFixed(4)}`,
            `  cumulative: $${cumulativeCost.toFixed(4)}`,
            `  rate:       $${perHour.toFixed(2)}/hr`,
            `  tokens:     ${fmtK(tokTotal)} total  ${fmtK(tokPerHr)}/hr`,
        ].join("\n");
        spawn("agentchat", [
            "send",
            "--identity", identity,
            AGENTCHAT_SERVER,
            AGENTCHAT_CHANNEL,
            msg,
        ], { detached: true, stdio: "ignore" }).unref();
    }
    cost() {
        const p = priceFor(this.model);
        const nonCachedIn = this.totalIn - this.totalCacheRead;
        return (nonCachedIn * p.in +
            this.totalOut * p.out +
            this.totalCacheWrite * (p.cacheWrite ?? p.in) +
            this.totalCacheRead * (p.cacheRead ?? p.in)) / 1_000_000;
    }
    elapsedHours() {
        if (this.startMs === null)
            return 0;
        return (Date.now() - this.startMs) / 3_600_000;
    }
    /** Format a one-line spend summary for the status log. */
    format() {
        const cost = this.cost();
        const hrs = this.elapsedHours();
        const tokTotal = this.totalIn + this.totalOut;
        const costStr = `$${cost.toFixed(4)}`;
        // Suppress rate until at least 60 seconds have elapsed — avoids absurd $/hr on first call
        const minHrsForRate = 1 / 60;
        if (hrs < minHrsForRate) {
            return C.gray(`[spend] ${costStr}`);
        }
        const perHour = cost / hrs;
        const tokPerHr = tokTotal / hrs;
        const rateStr = `$${perHour.toFixed(2)}/hr`;
        const tokStr = `${fmtK(tokPerHr)} tok/hr`;
        return C.gray(`[spend] ${costStr}  ${C.yellow(rateStr)}  ${tokStr}`);
    }
    formatBrief() {
        const cost = this.cost();
        const tokOut = this.totalOut;
        return C.gray(`$${cost.toFixed(4)} · ${tokOut} tokens`);
    }
    // --- Turn timing ---
    startTurn() { this._turnStartMs = Date.now(); }
    recordToolCalls(count) { this._turnToolCalls += count; }
    endTurn() {
        const elapsed = this._turnStartMs > 0 ? Date.now() - this._turnStartMs : 0;
        this._lastTurnMs = elapsed;
        if (elapsed > this._longestTurnMs)
            this._longestTurnMs = elapsed;
        this._totalTurnMs += elapsed;
        if (this._turnToolCalls > this._maxHorizon)
            this._maxHorizon = this._turnToolCalls;
        this._totalTurns++;
        this._turnToolCalls = 0;
        this._turnStartMs = 0;
    }
    get lastTurnMs() { return this._lastTurnMs; }
    get longestTurnMs() { return this._longestTurnMs; }
    get avgTurnMs() { return this._totalTurns > 0 ? this._totalTurnMs / this._totalTurns : 0; }
    get sessionMs() { return this.startMs ? Date.now() - this.startMs : 0; }
    get maxHorizon() { return this._maxHorizon; }
    get currentHorizon() { return this._turnToolCalls; }
    get totalTurns() { return this._totalTurns; }
    // --- Session summary ---
    formatSummary() {
        return `[Session] ${this._totalTurns} turns, ${this.fmtDuration(this.sessionMs)}, ` +
            `longest turn ${this.fmtDuration(this._longestTurnMs)}, max horizon ${this._maxHorizon}, ` +
            `$${this.cost().toFixed(4)} total`;
    }
    fmtDuration(ms) {
        if (ms < 1000)
            return `${ms}ms`;
        const s = ms / 1000;
        if (s < 60)
            return `${s.toFixed(1)}s`;
        return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
    }
    get tokens() { return { in: this.totalIn, out: this.totalOut }; }
    /** Capture all counters for warm state transfer. */
    snapshot() {
        return {
            startMs: this.startMs,
            totalIn: this.totalIn,
            totalOut: this.totalOut,
            totalCacheWrite: this.totalCacheWrite,
            totalCacheRead: this.totalCacheRead,
            model: this.model,
            turnStartMs: this._turnStartMs,
            lastTurnMs: this._lastTurnMs,
            longestTurnMs: this._longestTurnMs,
            totalTurnMs: this._totalTurnMs,
            totalTurns: this._totalTurns,
            turnToolCalls: this._turnToolCalls,
            maxHorizon: this._maxHorizon,
        };
    }
    /** Restore counters from a warm state snapshot. */
    restore(snap) {
        this.startMs = snap.startMs;
        this.totalIn = snap.totalIn;
        this.totalOut = snap.totalOut;
        this.totalCacheWrite = snap.totalCacheWrite;
        this.totalCacheRead = snap.totalCacheRead;
        this.model = snap.model;
        this._turnStartMs = snap.turnStartMs;
        this._lastTurnMs = snap.lastTurnMs;
        this._longestTurnMs = snap.longestTurnMs;
        this._totalTurnMs = snap.totalTurnMs;
        this._totalTurns = snap.totalTurns;
        this._turnToolCalls = snap.turnToolCalls;
        this._maxHorizon = snap.maxHorizon;
    }
}
function fmtK(n) {
    if (n >= 1_000_000)
        return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000)
        return (n / 1_000).toFixed(1) + "K";
    return n.toFixed(0);
}
/** Singleton for the session. */
export const spendMeter = new SpendMeter();

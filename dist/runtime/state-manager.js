/**
 * RuntimeStateManager — unified runtime state tracker.
 *
 * Aggregates state that is currently scattered across runtimeConfig,
 * spendMeter, ViolationTracker, and local variables in executeTurn().
 * This is a passive observer — it doesn't own business logic, just
 * provides a single queryable view of "what is the runtime doing now?"
 */
import { runtimeConfig } from "./config-manager.js";
import { spendMeter } from "../spend-meter.js";
// ---------------------------------------------------------------------------
// RuntimeStateManager
// ---------------------------------------------------------------------------
export class RuntimeStateManager {
    constructor() {
        this.session = {
            sessionId: null,
            sessionPersistence: false,
            mode: "single-shot",
            provider: "anthropic",
            startModel: "claude-sonnet-4-5",
            startedAt: Date.now(),
        };
        this.turn = {
            activeModel: "",
            activeThinkingBudget: 0.5,
            modelExplicitlySet: false,
            activeTemperature: undefined,
            activeTopK: undefined,
            activeTopP: undefined,
            currentRound: 0,
            maxToolRounds: 0,
            idleNudges: 0,
            consecutiveFailedRounds: 0,
            turnTokensIn: 0,
            turnTokensOut: 0,
        };
        this.violations = null;
    }
    // === Session-level (called once at startup) ===
    initSession(opts) {
        this.session = {
            sessionId: opts.sessionId,
            sessionPersistence: opts.sessionPersistence,
            mode: opts.mode,
            provider: opts.provider,
            startModel: opts.model,
            startedAt: Date.now(),
        };
        this.turn.activeModel = opts.model;
    }
    setViolationTracker(tracker) {
        this.violations = tracker;
    }
    // === Turn-level (called from executeTurn) ===
    beginTurn(opts) {
        this.turn.activeModel = opts.model;
        this.turn.maxToolRounds = opts.maxToolRounds;
        this.turn.currentRound = 0;
        this.turn.idleNudges = 0;
        this.turn.consecutiveFailedRounds = 0;
        this.turn.turnTokensIn = 0;
        this.turn.turnTokensOut = 0;
    }
    advanceRound() {
        this.turn.currentRound++;
    }
    setActiveModel(model) { this.turn.activeModel = model; }
    setModelExplicitlySet(v) { this.turn.modelExplicitlySet = v; }
    setThinkingBudget(budget) {
        this.turn.activeThinkingBudget = Math.max(0.0, Math.min(1.0, budget));
    }
    setTemperature(v) { this.turn.activeTemperature = v; }
    setTopK(v) { this.turn.activeTopK = v; }
    setTopP(v) { this.turn.activeTopP = v; }
    setIdleNudges(n) { this.turn.idleNudges = n; }
    setConsecutiveFailedRounds(n) { this.turn.consecutiveFailedRounds = n; }
    recordTurnUsage(inputTokens, outputTokens) {
        this.turn.turnTokensIn += inputTokens;
        this.turn.turnTokensOut += outputTokens;
    }
    // === Read accessors ===
    getSession() { return { ...this.session }; }
    getTurn() { return { ...this.turn }; }
    getActiveModel() { return this.turn.activeModel; }
    getThinkingBudget() { return this.turn.activeThinkingBudget; }
    isModelExplicitlySet() { return this.turn.modelExplicitlySet; }
    // === Snapshot ===
    snapshot() {
        const cfg = runtimeConfig.getConfig();
        const tokens = spendMeter.tokens;
        return {
            session: { ...this.session },
            turn: { ...this.turn },
            config: {
                memoryType: cfg.memoryType,
                model: cfg.model,
                provider: cfg.provider,
                thinkingLevel: cfg.thinkingLevel,
            },
            spend: {
                cost: spendMeter.cost(),
                tokensIn: tokens.in,
                tokensOut: tokens.out,
            },
            violations: this.violations ? {
                plainTextResponses: this.violations.plainTextResponses,
                idleRounds: this.violations.idleRounds,
                sameToolLoops: this.violations.sameToolLoops,
                totalViolations: this.violations.totalViolations,
            } : null,
            snapshotAt: new Date().toISOString(),
        };
    }
    /** Compact one-line summary for debug logging */
    format() {
        const t = this.turn;
        const s = this.session;
        return `[state] ${s.mode} r${t.currentRound}/${t.maxToolRounds} ` +
            `model=${t.activeModel} think=${t.activeThinkingBudget.toFixed(2)} ` +
            `tokens=${t.turnTokensIn + t.turnTokensOut}`;
    }
}
export const runtimeState = new RuntimeStateManager();

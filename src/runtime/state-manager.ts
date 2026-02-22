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
import type { ViolationTracker } from "../violations.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionState {
  sessionId: string | null;
  sessionPersistence: boolean;
  mode: "single-shot" | "interactive" | "persistent";
  provider: string;
  startModel: string;
  startedAt: number;
}

export interface TurnState {
  activeModel: string;
  activeThinkingBudget: number;
  modelExplicitlySet: boolean;
  activeTemperature: number | undefined;
  activeTopK: number | undefined;
  activeTopP: number | undefined;
  currentRound: number;
  maxToolRounds: number;
  idleNudges: number;
  consecutiveFailedRounds: number;
  turnTokensIn: number;
  turnTokensOut: number;
}

export interface RuntimeSnapshot {
  session: SessionState;
  turn: TurnState;
  config: {
    memoryType: string;
    model: string;
    provider: string;
    thinkingLevel: number;
  };
  spend: {
    cost: number;
    tokensIn: number;
    tokensOut: number;
  };
  violations: {
    plainTextResponses: number;
    idleRounds: number;
    sameToolLoops: number;
    totalViolations: number;
  } | null;
  snapshotAt: string;
}

// ---------------------------------------------------------------------------
// RuntimeStateManager
// ---------------------------------------------------------------------------

export class RuntimeStateManager {
  private session: SessionState = {
    sessionId: null,
    sessionPersistence: false,
    mode: "single-shot",
    provider: "anthropic",
    startModel: "claude-sonnet-4-5",
    startedAt: Date.now(),
  };

  private turn: TurnState = {
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

  private violations: ViolationTracker | null = null;

  // === Session-level (called once at startup) ===

  initSession(opts: {
    sessionId: string;
    sessionPersistence: boolean;
    mode: "single-shot" | "interactive" | "persistent";
    provider: string;
    model: string;
  }): void {
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

  setViolationTracker(tracker: ViolationTracker | null): void {
    this.violations = tracker;
  }

  // === Turn-level (called from executeTurn) ===

  beginTurn(opts: { model: string; maxToolRounds: number }): void {
    this.turn.activeModel = opts.model;
    this.turn.maxToolRounds = opts.maxToolRounds;
    this.turn.currentRound = 0;
    this.turn.idleNudges = 0;
    this.turn.consecutiveFailedRounds = 0;
    this.turn.turnTokensIn = 0;
    this.turn.turnTokensOut = 0;
  }

  advanceRound(): void {
    this.turn.currentRound++;
  }

  setActiveModel(model: string): void { this.turn.activeModel = model; }
  setModelExplicitlySet(v: boolean): void { this.turn.modelExplicitlySet = v; }

  setThinkingBudget(budget: number): void {
    this.turn.activeThinkingBudget = Math.max(0.0, Math.min(1.0, budget));
  }

  setTemperature(v: number | undefined): void { this.turn.activeTemperature = v; }
  setTopK(v: number | undefined): void { this.turn.activeTopK = v; }
  setTopP(v: number | undefined): void { this.turn.activeTopP = v; }

  setIdleNudges(n: number): void { this.turn.idleNudges = n; }
  setConsecutiveFailedRounds(n: number): void { this.turn.consecutiveFailedRounds = n; }

  recordTurnUsage(inputTokens: number, outputTokens: number): void {
    this.turn.turnTokensIn += inputTokens;
    this.turn.turnTokensOut += outputTokens;
  }

  // === Read accessors ===

  getSession(): Readonly<SessionState> { return { ...this.session }; }
  getTurn(): Readonly<TurnState> { return { ...this.turn }; }
  getActiveModel(): string { return this.turn.activeModel; }
  getThinkingBudget(): number { return this.turn.activeThinkingBudget; }
  isModelExplicitlySet(): boolean { return this.turn.modelExplicitlySet; }

  // === Snapshot ===

  snapshot(): RuntimeSnapshot {
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
  format(): string {
    const t = this.turn;
    const s = this.session;
    return `[state] ${s.mode} r${t.currentRound}/${t.maxToolRounds} ` +
           `model=${t.activeModel} think=${t.activeThinkingBudget.toFixed(2)} ` +
           `tokens=${t.turnTokensIn + t.turnTokensOut}`;
  }
}

export const runtimeState = new RuntimeStateManager();

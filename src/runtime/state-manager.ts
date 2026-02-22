/**
 * RuntimeStateManager — singleton for mutable per-session runtime state.
 *
 * Centralizes the sampling parameters and model state that were previously
 * scattered as local variables inside the main chat loop.
 *
 * State tracked:
 *   - activeModel       — current model (may change via 🔀)
 *   - thinkingBudget    — 0.0–1.0 thinking intensity lever
 *   - modelExplicitlySet — true after 🔀, suppresses auto-tier selection
 *   - temperature       — sampling temperature (🌡️ / 🌡️)
 *   - topK              — top-k sampling (⚙️)
 *   - topP              — nucleus sampling probability (⚙️)
 *
 * Usage:
 *   import { runtimeState } from "./state-manager.js";
 *   runtimeState.setTemperature(0.9);
 *   const t = runtimeState.temperature; // 0.9
 *   runtimeState.reset(); // back to defaults
 */

import { Logger } from "../logger.js";

export interface SamplingParams {
  temperature?: number;
  top_k?: number;
  top_p?: number;
}

export class RuntimeStateManager {
  private static _instance: RuntimeStateManager | null = null;

  // Model state
  private _activeModel: string = "";
  private _thinkingBudget: number = 0.5;
  private _modelExplicitlySet: boolean = false;

  // Sampling parameters
  private _temperature: number | undefined = undefined;
  private _topK: number | undefined = undefined;
  private _topP: number | undefined = undefined;

  private constructor() {}

  /** Get the singleton instance. */
  static getInstance(): RuntimeStateManager {
    if (!RuntimeStateManager._instance) {
      RuntimeStateManager._instance = new RuntimeStateManager();
    }
    return RuntimeStateManager._instance;
  }

  // ── Model state ──────────────────────────────────────────────────────────

  get activeModel(): string {
    return this._activeModel;
  }

  setActiveModel(model: string): void {
    Logger.debug(`RuntimeStateManager: activeModel → ${model}`);
    this._activeModel = model;
  }

  get thinkingBudget(): number {
    return this._thinkingBudget;
  }

  setThinkingBudget(budget: number): void {
    const clamped = Math.max(0.0, Math.min(1.0, budget));
    Logger.debug(`RuntimeStateManager: thinkingBudget → ${clamped}`);
    this._thinkingBudget = clamped;
  }

  get modelExplicitlySet(): boolean {
    return this._modelExplicitlySet;
  }

  setModelExplicitlySet(value: boolean): void {
    this._modelExplicitlySet = value;
  }

  // ── Sampling parameters ───────────────────────────────────────────────────

  get temperature(): number | undefined {
    return this._temperature;
  }

  /**
   * Set sampling temperature. Valid range: 0.0–2.0.
   * Pass undefined to clear (revert to provider default).
   */
  setTemperature(value: number | undefined): void {
    if (value !== undefined && (isNaN(value) || value < 0 || value > 2)) {
      Logger.warn(`RuntimeStateManager: temperature '${value}' out of range 0.0–2.0, ignoring`);
      return;
    }
    Logger.info(`RuntimeStateManager: temperature → ${value ?? "default"}`);
    this._temperature = value;
  }

  get topK(): number | undefined {
    return this._topK;
  }

  /**
   * Set top-k sampling. Must be a positive integer.
   * Pass undefined to clear (revert to provider default).
   */
  setTopK(value: number | undefined): void {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      Logger.warn(`RuntimeStateManager: top_k '${value}' invalid, must be positive integer, ignoring`);
      return;
    }
    Logger.info(`RuntimeStateManager: top_k → ${value ?? "default"}`);
    this._topK = value;
  }

  get topP(): number | undefined {
    return this._topP;
  }

  /**
   * Set nucleus sampling probability. Valid range: 0.0–1.0.
   * Pass undefined to clear (revert to provider default).
   */
  setTopP(value: number | undefined): void {
    if (value !== undefined && (isNaN(value) || value < 0 || value > 1)) {
      Logger.warn(`RuntimeStateManager: top_p '${value}' out of range 0.0–1.0, ignoring`);
      return;
    }
    Logger.info(`RuntimeStateManager: top_p → ${value ?? "default"}`);
    this._topP = value;
  }

  /**
   * Return current sampling params as a plain object, omitting undefined values.
   * Safe to spread directly into driver options.
   */
  getSamplingParams(): SamplingParams {
    const params: SamplingParams = {};
    if (this._temperature !== undefined) params.temperature = this._temperature;
    if (this._topK !== undefined) params.top_k = this._topK;
    if (this._topP !== undefined) params.top_p = this._topP;
    return params;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Initialize the singleton with a starting model and thinking budget.
   * Call once at session start before the chat loop.
   */
  initialize(model: string, thinkingBudget = 0.5): void {
    this._activeModel = model;
    this._thinkingBudget = thinkingBudget;
    this._modelExplicitlySet = false;
    this._temperature = undefined;
    this._topK = undefined;
    this._topP = undefined;
    Logger.debug(`RuntimeStateManager: initialized (model=${model}, thinking=${thinkingBudget})`);
  }

  /**
   * Reset sampling params only (temperature, top_k, top_p) back to undefined.
   * Does not reset model or thinking budget.
   */
  resetSamplingParams(): void {
    this._temperature = undefined;
    this._topK = undefined;
    this._topP = undefined;
    Logger.debug("RuntimeStateManager: sampling params reset to defaults");
  }

  /**
   * Full reset — clears all state back to defaults.
   * Primarily for testing.
   */
  reset(): void {
    this._activeModel = "";
    this._thinkingBudget = 0.5;
    this._modelExplicitlySet = false;
    this._temperature = undefined;
    this._topK = undefined;
    this._topP = undefined;
  }
}

/** Module-level singleton export — use this everywhere. */
export const runtimeState = RuntimeStateManager.getInstance();

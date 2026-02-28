/**
 * SensoryMemory — decorator that injects a sensory buffer into any AgentMemory.
 *
 * Wraps an inner AgentMemory and adds a compact sensory block (context map,
 * environment state, etc.) as a system message right after the system prompt.
 * Zero changes to existing memory modules — works with all memory types.
 *
 * Two-slot camera system: slot0 and slot1 are both agent-switchable via the
 * stream marker. Default: slot0="context", slot1="time".
 * Use <view:X> to set slot0, <view:X,1> to set slot1.
 *
 * Usage:
 *   const inner = new VirtualMemory({ ... });
 *   const sensory = new SensoryMemory(inner, { totalBudget: 500 });
 *   sensory.addChannel({ name: "context", ... source: contextMapSource });
 *   sensory.addChannel({ name: "time",    ... source: temporalSource });
 *   sensory.setSlot(0, "context");
 *   sensory.setSlot(1, "time");
 *   // Before each turn:
 *   await sensory.pollSources();
 *   const msgs = sensory.messages(); // inner messages + sensory buffer at index 1
 */

import type { ChatMessage } from "../drivers/types.js";
import { AgentMemory, type MemoryStats } from "./agent-memory.js";
import { Logger } from "../logger.js";

// --- Interfaces ---

export interface SensorySource {
  /** Called each turn to produce fresh content. Return null to skip. */
  poll(): Promise<string | null>;
  /** Clean up resources. */
  destroy(): void;
}

export interface SensoryChannel {
  name: string;
  maxTokens: number;
  updateMode: "every_turn" | "manual";
  content: string;
  enabled: boolean;
  source?: SensorySource;
}

export interface SensoryMemoryConfig {
  totalBudget?: number;
  avgCharsPerToken?: number;
}

// --- SensoryMemory ---

export class SensoryMemory extends AgentMemory {
  private inner: AgentMemory;
  private channels: Map<string, SensoryChannel> = new Map();
  private totalBudget: number;
  private avgCharsPerToken: number;
  /** Three camera slots — all agent-switchable. null = slot disabled. */
  private slots: [string | null, string | null, string | null] = [null, null, null];
  /** Saved slot state during full-screen expand. */
  private savedSlots: [string | null, string | null, string | null] | null = null;
  /** Saved maxTokens per channel during full-screen expand. */
  private savedMaxTokens: Map<string, number> = new Map();
  /** Countdown for full-screen expand restoration. */
  private expandTurnsRemaining = 0;

  constructor(inner: AgentMemory, config: SensoryMemoryConfig = {}) {
    // Don't pass systemPrompt — inner already has it
    super();
    // Clear the empty messagesBuffer created by super() — we delegate everything to inner
    this.messagesBuffer = [] as any; // unused, inner owns messages
    this.inner = inner;
    this.totalBudget = config.totalBudget ?? 500;
    this.avgCharsPerToken = config.avgCharsPerToken ?? 2.8;
  }

  // --- Channel management ---

  addChannel(channel: SensoryChannel): void {
    this.channels.set(channel.name, channel);
  }

  removeChannel(name: string): void {
    const ch = this.channels.get(name);
    if (ch?.source) ch.source.destroy();
    this.channels.delete(name);
  }

  setEnabled(name: string, enabled: boolean): void {
    const ch = this.channels.get(name);
    if (ch) ch.enabled = enabled;
  }

  update(name: string, content: string): void {
    const ch = this.channels.get(name);
    if (!ch) return;
    // Enforce per-channel token limit
    const maxChars = ch.maxTokens * this.avgCharsPerToken;
    ch.content = content.length > maxChars ? content.slice(0, maxChars) + "..." : content;
  }

  // --- Camera slot management ---

  /**
   * Set a camera slot to a named channel.
   * @param slot 0 or 1
   * @param channelName name of a registered channel, or null to clear slot
   */
  setSlot(slot: 0 | 1 | 2, channelName: string | null): void {
    this.slots[slot] = channelName;
    Logger.telemetry(`[Sensory] slot${slot} → ${channelName ?? "off"}`);
  }

  getSlot(slot: 0 | 1 | 2): string | null {
    return this.slots[slot];
  }

  /** Switch a camera slot. If channelName exists, activate it. */
  switchView(channelName: string, slot: 0 | 1 | 2 = 0): void {
    if (!this.channels.has(channelName)) {
      Logger.warn(`[Sensory] switchView: unknown channel '${channelName}'`);
      return;
    }
    this.setSlot(slot, channelName);
  }

  /** Get channel names in registration order — used for view cycling. */
  getChannelNames(): string[] {
    return Array.from(this.channels.keys());
  }

  /** Get the source for a named channel (for late-binding dependency injection). */
  getChannelSource(name: string): SensorySource | undefined {
    return this.channels.get(name)?.source;
  }

  /** Cycle slot0 to the next/previous channel in registration order. */
  cycleSlot0(direction: "next" | "prev"): void {
    const names = this.getChannelNames();
    if (names.length === 0) return;
    const current = this.slots[0];
    let idx = current ? names.indexOf(current) : -1;
    if (direction === "next") {
      idx = (idx + 1) % names.length;
    } else {
      idx = idx <= 0 ? names.length - 1 : idx - 1;
    }
    this.setSlot(0, names[idx]);
  }

  /**
   * Full-screen expand: commandeer all 3 slots for a single channel for one turn.
   * Saves current slot config and boosts the channel's token budget to the total budget.
   * Automatically restores after the next pollSources() cycle.
   */
  expandForOneTurn(channelName: string): void {
    const ch = this.channels.get(channelName);
    if (!ch) {
      Logger.warn(`[Sensory] expandForOneTurn: unknown channel '${channelName}'`);
      return;
    }
    // Save current state
    this.savedSlots = [...this.slots] as [string | null, string | null, string | null];
    this.savedMaxTokens.set(channelName, ch.maxTokens);
    // Expand: all budget to this channel, clear other slots
    ch.maxTokens = this.totalBudget;
    this.slots = [channelName, null, null];
    // 2 = next poll renders expanded, then restore before the poll after that
    this.expandTurnsRemaining = 2;
    Logger.telemetry(`[Sensory] Full-screen expand: ${channelName} (budget: ${this.totalBudget})`);
  }

  /** Restore slot config and channel budgets after full-screen expand. */
  private restoreFromExpand(): void {
    if (this.savedSlots) {
      this.slots = this.savedSlots;
      this.savedSlots = null;
    }
    for (const [name, maxTok] of this.savedMaxTokens) {
      const ch = this.channels.get(name);
      if (ch) ch.maxTokens = maxTok;
    }
    this.savedMaxTokens.clear();
    Logger.telemetry(`[Sensory] Restored from full-screen expand`);
  }

  /** Poll all every_turn sources for fresh content. Call before driver.chat(). */
  async pollSources(): Promise<void> {
    // Handle full-screen expand lifecycle
    if (this.expandTurnsRemaining > 0) {
      this.expandTurnsRemaining--;
      if (this.expandTurnsRemaining === 0) {
        this.restoreFromExpand();
      }
    }

    for (const [name, ch] of this.channels) {
      if (!ch.enabled || ch.updateMode !== "every_turn" || !ch.source) continue;
      try {
        const content = await ch.source.poll();
        if (content !== null) {
          this.update(name, content);
        }
      } catch (err) {
        Logger.warn(`[Sensory] Channel '${name}' poll failed: ${err}`);
      }
    }
  }

  /** Handle @@sense@@ marker from stream. Args: channel (or action), action. */
  onSenseMarker(channelOrAction: string, action: string): void {
    // If first arg is an action keyword with no channel → apply to all channels
    // Otherwise first arg is channel name, second is action
    const isAction = (s: string) => ["off", "disable", "on", "enable"].includes(s);

    let channel: string;
    let op: string;
    if (isAction(channelOrAction) && !action) {
      // @@sense('off')@@ — disable all
      channel = "";
      op = channelOrAction;
    } else if (!isAction(channelOrAction) && isAction(action)) {
      // @@sense('context,off')@@ — channel first, action second
      channel = channelOrAction;
      op = action;
    } else if (isAction(channelOrAction)) {
      // @@sense('off,context')@@ — action first, channel second (legacy compat)
      channel = action;
      op = channelOrAction;
    } else {
      return; // unrecognized
    }

    if (op === "off" || op === "disable") {
      if (channel) {
        this.setEnabled(channel, false);
      } else {
        for (const ch of this.channels.values()) ch.enabled = false;
      }
    } else if (op === "on" || op === "enable") {
      if (channel) {
        this.setEnabled(channel, true);
      } else {
        for (const ch of this.channels.values()) ch.enabled = true;
      }
    }
  }

  // --- Inner memory access ---

  getInner(): AgentMemory {
    return this.inner;
  }

  setInner(newInner: AgentMemory): void {
    this.inner = newInner;
    // Update sources that hold a reference to the inner memory
    for (const ch of this.channels.values()) {
      if (ch.source && "setMemory" in ch.source && typeof (ch.source as any).setMemory === "function") {
        (ch.source as any).setMemory(newInner);
      }
    }
  }

  // --- Render ---

  private renderBuffer(): string {
    // Gather content from the three camera slots (in order)
    const slotContents: Array<{ name: string; content: string }> = [];
    for (const slotName of this.slots) {
      if (!slotName) continue;
      const ch = this.channels.get(slotName);
      if (ch && ch.enabled && ch.content) {
        slotContents.push({ name: slotName, content: ch.content });
      }
    }

    // Fallback: if no slots configured, render all enabled channels (legacy)
    const items = slotContents.length > 0
      ? slotContents
      : Array.from(this.channels.values())
          .filter(ch => ch.enabled && ch.content)
          .map(ch => ({ name: ch.name, content: ch.content }));

    if (items.length === 0) return "";

    const parts: string[] = [];
    let totalChars = 0;
    const maxChars = this.totalBudget * this.avgCharsPerToken;

    for (const item of items) {
      const section = `[${item.name}]\n${item.content}`;
      if (totalChars + section.length > maxChars && parts.length > 0) break;
      parts.push(section);
      totalChars += section.length;
    }

    return `--- SENSORY BUFFER ---\n${parts.join("\n\n")}\n--- END SENSORY BUFFER ---`;
  }

  // --- AgentMemory overrides (delegation + injection) ---

  override messages(): ChatMessage[] {
    const inner = this.inner.messages();
    const buffer = this.renderBuffer();
    if (!buffer) return inner;

    const sensoryMsg: ChatMessage = {
      role: "system",
      content: buffer,
      from: "SensoryMemory",
    };

    // Inject at index 1 (after system prompt, before conversation)
    const result = [...inner];
    if (result.length > 0 && result[0].role === "system") {
      result.splice(1, 0, sensoryMsg);
    } else {
      result.unshift(sensoryMsg);
    }
    return result;
  }

  override async add(msg: ChatMessage): Promise<void> {
    await this.inner.add(msg);
  }

  override async addIfNotExists(msg: ChatMessage): Promise<void> {
    await this.inner.addIfNotExists(msg);
  }

  override async load(id: string): Promise<void> {
    await this.inner.load(id);
  }

  override async save(id: string): Promise<void> {
    await this.inner.save(id);
  }

  override setModel(model: string): void {
    this.inner.setModel(model);
  }

  override setThinkingBudget(budget: number): void {
    this.inner.setThinkingBudget(budget);
  }

  override protectMessage(msg: ChatMessage): void {
    this.inner.protectMessage(msg);
  }

  override unprotectMessage(msg: ChatMessage): void {
    this.inner.unprotectMessage(msg);
  }

  override clearProtectedMessages(): void {
    this.inner.clearProtectedMessages();
  }

  override async preToolCompact(threshold?: number): Promise<boolean> {
    return this.inner.preToolCompact(threshold);
  }

  override getStats(): MemoryStats {
    return this.inner.getStats();
  }

  protected override async onAfterAdd(): Promise<void> {
    // Handled by inner memory
  }
}

/**
 * SensoryMemory — decorator that injects a sensory buffer into any AgentMemory.
 *
 * Wraps an inner AgentMemory and adds a compact sensory block (context map,
 * environment state, etc.) as a system message right after the system prompt.
 * Zero changes to existing memory modules — works with all memory types.
 *
 * Usage:
 *   const inner = new VirtualMemory({ ... });
 *   const sensory = new SensoryMemory(inner, { totalBudget: 500 });
 *   sensory.addChannel({ name: "context", ... source: contextMapSource });
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

  /** Poll all every_turn sources for fresh content. Call before driver.chat(). */
  async pollSources(): Promise<void> {
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

  /** Handle @@sense@@ marker from stream. */
  onSenseMarker(action: string, value: string): void {
    if (action === "off" || action === "disable") {
      if (value) {
        this.setEnabled(value, false);
      } else {
        // Disable all channels
        for (const ch of this.channels.values()) ch.enabled = false;
      }
    } else if (action === "on" || action === "enable") {
      if (value) {
        this.setEnabled(value, true);
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
    // Update any sources that hold a reference to the inner memory
    // (ContextMapSource constructor takes the inner memory ref)
  }

  // --- Render ---

  private renderBuffer(): string {
    const enabled = Array.from(this.channels.values()).filter(ch => ch.enabled && ch.content);
    if (enabled.length === 0) return "";

    const parts: string[] = [];
    let totalChars = 0;
    const maxChars = this.totalBudget * this.avgCharsPerToken;

    for (const ch of enabled) {
      const header = `[${ch.name}]`;
      const section = `${header}\n${ch.content}`;
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

  override getStats(): MemoryStats {
    return this.inner.getStats();
  }

  protected override async onAfterAdd(): Promise<void> {
    // Handled by inner memory
  }
}

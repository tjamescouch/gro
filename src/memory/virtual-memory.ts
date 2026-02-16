import type { ChatDriver, ChatMessage } from "../drivers/types.js";
import { AgentMemory } from "./agent-memory.js";
import { saveSession, loadSession, ensureGroDir } from "../session.js";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Logger } from "../logger.js";

/**
 * VirtualMemory — paged context with inline refs and independent budgets.
 *
 * Buffer layout:
 *   [system prompt]
 *   [page slot — reserved budget for loaded pages]
 *   [working memory — recent messages, older ones fade to summaries with embedded refs]
 *
 * When working memory exceeds its budget, the oldest raw messages are:
 * 1. Saved as an immutable page on disk
 * 2. Replaced with a compact summary containing inline  links
 *
 * The model encounters refs naturally while reading summaries and can
 * request the full page by emitting . Pages load into
 * the page slot on the next turn. If the slot is full, oldest loaded
 * page is evicted.
 *
 * No separate page index — refs are hyperlinks woven into the text.
 */

// --- Types ---

export interface ContextPage {
  id: string;
  label: string;
  content: string;
  createdAt: string;
  messageCount: number;
  tokens: number;
}

export interface VirtualMemoryConfig {
  /** Directory for page storage (default: ~/.gro/pages/) */
  pagesDir?: string;
  /** Token budget for the page slot (loaded pages) */
  pageSlotTokens?: number;
  /** Token budget for working memory (recent messages + summaries) */
  workingMemoryTokens?: number;
  /** Characters per token estimate */
  avgCharsPerToken?: number;
  /** Minimum recent messages to always keep raw (never summarize) */
  minRecentMessages?: number;
  /** High watermark ratio — trigger summarization when working memory exceeds this */
  highRatio?: number;
  /** Low watermark ratio — summarize down to this level */
  lowRatio?: number;
  /** System prompt */
  systemPrompt?: string;
  /** Driver for summarization calls */
  driver?: ChatDriver;
  /** Model to use for summarization */
  summarizerModel?: string;
}

const DEFAULTS = {
  pagesDir: join(process.env.HOME ?? "/tmp", ".gro", "pages"),
  pageSlotTokens: 40_000,
  workingMemoryTokens: 80_000,
  avgCharsPerToken: 2.8,
  minRecentMessages: 6,
  highRatio: 0.75,
  lowRatio: 0.50,
  systemPrompt: "",
  summarizerModel: "claude-3-haiku-20240307",
};

// --- VirtualMemory ---

export class VirtualMemory extends AgentMemory {
  private cfg: Required<Omit<VirtualMemoryConfig, "driver" | "summarizerModel">> & {
    driver: ChatDriver | null;
    summarizerModel: string;
  };

  /** All known pages */
  private pages: Map<string, ContextPage> = new Map();

  /** Currently loaded page IDs (in the page slot) */
  private activePageIds: Set<string> = new Set();

  /** Pages requested by the model via @@ref markers */
  private pendingRefs: Set<string> = new Set();

  /** Pages to unload */
  private pendingUnrefs: Set<string> = new Set();

  /** Load order for eviction (oldest first) */
  private loadOrder: string[] = [];

  private model = "unknown";

  constructor(config: VirtualMemoryConfig = {}) {
    super(config.systemPrompt);
    this.cfg = {
      pagesDir: config.pagesDir ?? DEFAULTS.pagesDir,
      pageSlotTokens: config.pageSlotTokens ?? DEFAULTS.pageSlotTokens,
      workingMemoryTokens: config.workingMemoryTokens ?? DEFAULTS.workingMemoryTokens,
      avgCharsPerToken: config.avgCharsPerToken ?? DEFAULTS.avgCharsPerToken,
      minRecentMessages: config.minRecentMessages ?? DEFAULTS.minRecentMessages,
      highRatio: config.highRatio ?? DEFAULTS.highRatio,
      lowRatio: config.lowRatio ?? DEFAULTS.lowRatio,
      systemPrompt: config.systemPrompt ?? DEFAULTS.systemPrompt,
      driver: config.driver ?? null,
      summarizerModel: config.summarizerModel ?? DEFAULTS.summarizerModel,
    };
    mkdirSync(this.cfg.pagesDir, { recursive: true });
  }

  override setModel(model: string): void {
    this.model = model;
  }

  // --- Persistence ---

  async load(id: string): Promise<void> {
    const session = loadSession(id);
    if (session) {
      this.messagesBuffer = session.messages;
    }
    this.loadPageIndex();
  }

  async save(id: string): Promise<void> {
    ensureGroDir();
    saveSession(id, this.messagesBuffer, {
      id,
      provider: "unknown",
      model: this.model,
      createdAt: new Date().toISOString(),
    });
    this.savePageIndex();
  }

  // --- Page Index (persisted metadata) ---

  private indexPath(): string {
    return join(this.cfg.pagesDir, "index.json");
  }

  private loadPageIndex(): void {
    const p = this.indexPath();
    if (!existsSync(p)) return;
    try {
      const data = JSON.parse(readFileSync(p, "utf8"));
      this.pages.clear();
      for (const page of data.pages ?? []) this.pages.set(page.id, page);
      this.activePageIds = new Set(data.activePageIds ?? []);
      this.loadOrder = data.loadOrder ?? [];
    } catch {
      this.pages.clear();
    }
  }

  private savePageIndex(): void {
    mkdirSync(this.cfg.pagesDir, { recursive: true });
    writeFileSync(this.indexPath(), JSON.stringify({
      pages: Array.from(this.pages.values()),
      activePageIds: Array.from(this.activePageIds),
      loadOrder: this.loadOrder,
      savedAt: new Date().toISOString(),
    }, null, 2) + "\n");
  }

  // --- Page Storage ---

  private pagePath(id: string): string {
    return join(this.cfg.pagesDir, `${id}.json`);
  }

  private savePage(page: ContextPage): void {
    mkdirSync(this.cfg.pagesDir, { recursive: true });
    writeFileSync(this.pagePath(page.id), JSON.stringify(page, null, 2) + "\n");
    this.pages.set(page.id, page);
  }

  private loadPageContent(id: string): string | null {
    const cached = this.pages.get(id);
    if (cached) return cached.content;
    const p = this.pagePath(id);
    if (!existsSync(p)) return null;
    try {
      const page: ContextPage = JSON.parse(readFileSync(p, "utf8"));
      this.pages.set(id, page);
      return page.content;
    } catch {
      return null;
    }
  }

  // --- Ref/Unref (called by marker handler) ---

  ref(pageId: string): void {
    this.pendingRefs.add(pageId);
    this.pendingUnrefs.delete(pageId);
  }

  unref(pageId: string): void {
    this.pendingUnrefs.add(pageId);
    this.pendingRefs.delete(pageId);
  }

  // --- Token Math ---

  private tokensFor(text: string): number {
    return Math.ceil(text.length / this.cfg.avgCharsPerToken);
  }

  private msgTokens(msgs: ChatMessage[]): number {
    let chars = 0;
    for (const m of msgs) {
      const s = String(m.content ?? "");
      chars += (s.length > 24_000 ? 24_000 : s.length) + 32;
    }
    return Math.ceil(chars / this.cfg.avgCharsPerToken);
  }

  // --- Page Creation ---

  private generatePageId(content: string): string {
    return "pg_" + createHash("sha256").update(content).digest("hex").slice(0, 12);
  }

  /**
   * Create a page from raw messages and return a summary with embedded ref.
   * The raw content is saved to disk; the returned summary replaces it in working memory.
   */
  async createPageFromMessages(
    messages: ChatMessage[],
    label: string,
  ): Promise<{ page: ContextPage; summary: string }> {
    // Build raw content for the page
    const rawContent = messages.map(m =>
      `[${m.role}${m.from ? ` (${m.from})` : ""}]: ${String(m.content ?? "").slice(0, 8000)}`
    ).join("\n\n");

    const page: ContextPage = {
      id: this.generatePageId(rawContent),
      label,
      content: rawContent,
      createdAt: new Date().toISOString(),
      messageCount: messages.length,
      tokens: this.tokensFor(rawContent),
    };
    this.savePage(page);

    // Generate summary with embedded ref
    let summary: string;
    if (this.cfg.driver) {
      summary = await this.summarizeWithRef(messages, page.id, label);
    } else {
      // Fallback: simple label + ref without LLM
      summary = `[Summary of ${messages.length} messages: ${label}] `;
    }

    return { page, summary };
  }

  private async summarizeWithRef(
    messages: ChatMessage[],
    pageId: string,
    label: string,
  ): Promise<string> {
    const transcript = messages.map(m => {
      const c = String(m.content ?? "").slice(0, 4000);
      return `${m.role.toUpperCase()}: ${c}`;
    }).join("\n");

    const sys: ChatMessage = {
      role: "system",
      from: "System",
      content: [
        "You are a precise summarizer. Output concise bullet points preserving facts, tasks, file paths, commands, and decisions.",
        `End the summary with: `,
        "This ref is a hyperlink to the full conversation. Always include it.",
        "Hard limit: ~500 characters.",
      ].join(" "),
    };

    const usr: ChatMessage = {
      role: "user",
      from: "User",
      content: `Summarize this conversation segment (${label}):\n\n${transcript.slice(0, 12000)}`,
    };

    try {
      const out = await this.cfg.driver!.chat([sys, usr], { model: this.cfg.summarizerModel });
      let text = String((out as any)?.text ?? "").trim();
      // Ensure ref is present
      if (!text.includes(``)) {
        text += `\n`;
      }
      return text;
    } catch {
      return `[Summary of ${messages.length} messages: ${label}] `;
    }
  }

  // --- Context Assembly ---

  override messages(): ChatMessage[] {
    // Resolve pending refs/unrefs
    for (const id of this.pendingUnrefs) {
      this.activePageIds.delete(id);
      this.loadOrder = this.loadOrder.filter(x => x !== id);
    }
    for (const id of this.pendingRefs) {
      if (this.pages.has(id) || existsSync(this.pagePath(id))) {
        this.activePageIds.add(id);
        if (!this.loadOrder.includes(id)) this.loadOrder.push(id);
      }
    }
    this.pendingRefs.clear();
    this.pendingUnrefs.clear();

    // Evict oldest pages if slot is over budget
    this.evictPages();

    const result: ChatMessage[] = [];
    let usedTokens = 0;

    // 1. System prompt
    const sysMsg = this.messagesBuffer.find(m => m.role === "system");
    if (sysMsg) {
      result.push(sysMsg);
      usedTokens += this.msgTokens([sysMsg]);
    }

    // 2. Page slot — loaded pages
    const pageMessages = this.buildPageSlot();
    if (pageMessages.length > 0) {
      result.push(...pageMessages);
      usedTokens += this.msgTokens(pageMessages);
    }

    // 3. Working memory — recent messages within budget
    const wmBudget = this.cfg.workingMemoryTokens;
    const nonSystem = this.messagesBuffer.filter(m => m !== sysMsg);
    const window: ChatMessage[] = [];
    let wmTokens = 0;

    for (let i = nonSystem.length - 1; i >= 0; i--) {
      const msg = nonSystem[i];
      const mt = this.msgTokens([msg]);
      if (wmTokens + mt > wmBudget && window.length >= this.cfg.minRecentMessages) break;
      window.unshift(msg);
      wmTokens += mt;
      if (wmTokens > wmBudget * 2) break;
    }

    result.push(...window);
    return result;
  }

  private buildPageSlot(): ChatMessage[] {
    const msgs: ChatMessage[] = [];
    let slotTokens = 0;

    for (const id of this.loadOrder) {
      if (!this.activePageIds.has(id)) continue;
      const content = this.loadPageContent(id);
      if (!content) continue;
      const page = this.pages.get(id);
      const tokens = this.tokensFor(content);
      if (slotTokens + tokens > this.cfg.pageSlotTokens) continue;

      msgs.push({
        role: "system",
        from: "VirtualMemory",
        content: `--- Loaded Page: ${id} (${page?.label ?? "unknown"}) ---\n${content}\n--- End Page: ${id} (use  to release) ---`,
      });
      slotTokens += tokens;
    }
    return msgs;
  }

  private evictPages(): void {
    let slotTokens = 0;
    for (const id of this.loadOrder) {
      const page = this.pages.get(id);
      if (page) slotTokens += page.tokens;
    }

    while (slotTokens > this.cfg.pageSlotTokens && this.loadOrder.length > 0) {
      const evictId = this.loadOrder.shift()!;
      this.activePageIds.delete(evictId);
      const page = this.pages.get(evictId);
      if (page) slotTokens -= page.tokens;
    }
  }

  // --- Background Summarization ---

  protected async onAfterAdd(): Promise<void> {
    if (!this.cfg.driver) return;

    const wmBudget = this.cfg.workingMemoryTokens;
    const nonSystem = this.messagesBuffer.filter(m => m.role !== "system");
    const currentTokens = this.msgTokens(nonSystem);

    // VM diagnostics logging (if GRO_VM_DEBUG=true)
    if (process.env.GRO_VM_DEBUG === "true") {
      const highWatermark = Math.floor(wmBudget * this.cfg.highRatio);
      const lowWatermark = Math.floor(wmBudget * this.cfg.lowRatio);
      const willPage = currentTokens > highWatermark;
      Logger.info(`[VM] tokens=${currentTokens} high=${highWatermark} low=${lowWatermark} paging=${willPage}`);
    }

    if (currentTokens <= wmBudget * this.cfg.highRatio) return;

    await this.runOnce(async () => {
      const nonSys = this.messagesBuffer.filter(m => m.role !== "system");
      const est = this.msgTokens(nonSys);
      if (est <= wmBudget * this.cfg.highRatio) return;

      const targetTokens = Math.floor(wmBudget * this.cfg.lowRatio);

      // Find how many old messages to summarize
      const protect = this.cfg.minRecentMessages;
      const summarizable = nonSys.slice(0, Math.max(0, nonSys.length - protect));
      if (summarizable.length < 2) return;

      // Take a chunk of oldest messages to page out
      const chunkSize = Math.min(summarizable.length, Math.max(4, Math.floor(summarizable.length / 2)));
      const toPage = summarizable.slice(0, chunkSize);

      // Create page + summary
      const label = `session ${new Date().toISOString().slice(0, 16)} (${toPage.length} msgs)`;
      const { summary } = await this.createPageFromMessages(toPage, label);

      // Replace paged messages with summary in buffer
      const sysMsg = this.messagesBuffer.find(m => m.role === "system");
      const startIdx = sysMsg ? 1 : 0;

      this.messagesBuffer.splice(startIdx, chunkSize, {
        role: "assistant",
        from: "VirtualMemory",
        content: summary,
      });
    });
  }

  // --- Accessors ---

  getPages(): ContextPage[] { return Array.from(this.pages.values()); }
  getActivePageIds(): string[] { return Array.from(this.activePageIds); }
  getPageCount(): number { return this.pages.size; }
  hasPage(id: string): boolean { return this.pages.has(id); }
}

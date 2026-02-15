import type { ChatMessage } from "../drivers/types.js";
import { AgentMemory } from "./agent-memory.js";
import { saveSession, loadSession, ensureGroDir } from "../session.js";
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

/**
 * VirtualMemory — paged context management for long-running agents.
 *
 * Instead of keeping all messages in context (and blowing up the token budget),
 * VirtualMemory maintains a sliding window of recent messages plus a page index
 * of older, summarized context. The model can explicitly reference older pages
 * via  markers, which the runtime resolves on the next turn.
 *
 * Architecture:
 *   [system prompt]
 *   [page index — one-line descriptions of available pages]
 *   [active pages — explicitly loaded via @@ref@@]
 *   [recent messages — sliding window within token budget]
 *
 * Pages are immutable once created — they're summaries of conversation windows.
 * New conversation creates new pages when the window slides.
 */

// --- Types ---

export interface ContextPage {
  /** Unique page identifier */
  id: string;
  /** One-line description for the page index */
  label: string;
  /** Full summarized content of this page */
  content: string;
  /** Timestamp when page was created */
  createdAt: string;
  /** Number of original messages that were summarized into this page */
  messageCount: number;
  /** Approximate token count of the content */
  tokens: number;
}

export interface VirtualMemoryConfig {
  /** Base directory for storing pages (default: ~/.gro/pages/) */
  pagesDir?: string;
  /** Max tokens for the recent messages window */
  windowTokens?: number;
  /** Max tokens for loaded active pages */
  activePageTokens?: number;
  /** Max tokens for the page index */
  indexTokens?: number;
  /** Characters per token estimate */
  avgCharsPerToken?: number;
  /** Messages to keep in the recent window minimum */
  minRecentMessages?: number;
  /** System prompt */
  systemPrompt?: string;
}

const DEFAULT_CONFIG: Required<VirtualMemoryConfig> = {
  pagesDir: join(process.env.HOME ?? "/tmp", ".gro", "pages"),
  windowTokens: 80_000,
  activePageTokens: 40_000,
  indexTokens: 4_000,
  avgCharsPerToken: 2.8,
  minRecentMessages: 6,
  systemPrompt: "",
};

// --- VirtualMemory ---

export class VirtualMemory extends AgentMemory {
  private config: Required<VirtualMemoryConfig>;

  /** All known pages (the full index) */
  private pages: Map<string, ContextPage> = new Map();

  /** Currently loaded page IDs (in context) */
  private activePageIds: Set<string> = new Set();

  /** Pending ref requests from the model (resolved on next messages() call) */
  private pendingRefs: Set<string> = new Set();

  /** Pending unref requests */
  private pendingUnrefs: Set<string> = new Set();

  private model = "unknown";

  constructor(config: VirtualMemoryConfig = {}) {
    super(config.systemPrompt);
    this.config = { ...DEFAULT_CONFIG, ...config } as Required<VirtualMemoryConfig>;
    mkdirSync(this.config.pagesDir, { recursive: true });
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

  // --- Page Index ---

  private indexPath(): string {
    return join(this.config.pagesDir, "index.json");
  }

  private loadPageIndex(): void {
    const p = this.indexPath();
    if (!existsSync(p)) return;
    try {
      const data = JSON.parse(readFileSync(p, "utf8"));
      this.pages.clear();
      for (const page of data.pages ?? []) {
        this.pages.set(page.id, page);
      }
      this.activePageIds = new Set(data.activePageIds ?? []);
    } catch {
      // Corrupted index — start fresh
      this.pages.clear();
      this.activePageIds.clear();
    }
  }

  private savePageIndex(): void {
    mkdirSync(this.config.pagesDir, { recursive: true });
    const data = {
      pages: Array.from(this.pages.values()),
      activePageIds: Array.from(this.activePageIds),
      savedAt: new Date().toISOString(),
    };
    writeFileSync(this.indexPath(), JSON.stringify(data, null, 2) + "\n");
  }

  // --- Page Storage ---

  private pagePath(pageId: string): string {
    return join(this.config.pagesDir, `${pageId}.json`);
  }

  private savePage(page: ContextPage): void {
    mkdirSync(this.config.pagesDir, { recursive: true });
    writeFileSync(this.pagePath(page.id), JSON.stringify(page, null, 2) + "\n");
    this.pages.set(page.id, page);
  }

  private loadPage(pageId: string): ContextPage | null {
    // Check in-memory first
    const cached = this.pages.get(pageId);
    if (cached) return cached;

    // Try disk
    const p = this.pagePath(pageId);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  }

  // --- Ref Management ---

  /**
   * Request a page be loaded into context. Called when  is detected.
   */
  ref(pageId: string): void {
    if (this.pages.has(pageId)) {
      this.pendingRefs.add(pageId);
      this.pendingUnrefs.delete(pageId);
    }
  }

  /**
   * Request a page be unloaded from context. Called when  is detected.
   */
  unref(pageId: string): void {
    this.pendingUnrefs.add(pageId);
    this.pendingRefs.delete(pageId);
  }

  // --- Token Estimation ---

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / this.config.avgCharsPerToken);
  }

  private messageTokens(msgs: ChatMessage[]): number {
    let chars = 0;
    for (const m of msgs) {
      const s = String(m.content ?? "");
      chars += (s.length > 24_000 ? 24_000 : s.length) + 32;
    }
    return Math.ceil(chars / this.config.avgCharsPerToken);
  }

  // --- Page Creation ---

  /**
   * Generate a deterministic page ID from content hash.
   */
  private generatePageId(content: string): string {
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
    return `pg_${hash}`;
  }

  /**
   * Create a new page from a set of messages. The messages are summarized
   * into a single content block with a descriptive label.
   */
  createPage(label: string, content: string, messageCount: number): ContextPage {
    const page: ContextPage = {
      id: this.generatePageId(content),
      label,
      content,
      createdAt: new Date().toISOString(),
      messageCount,
      tokens: this.estimateTokens(content),
    };
    this.savePage(page);
    return page;
  }

  // --- Context Assembly ---

  /**
   * Build the page index message — a compact list of available pages
   * the model can reference with .
   */
  private buildPageIndex(): string {
    if (this.pages.size === 0) return "";

    const lines = ["Available context pages (use  to load,  to release):"];
    for (const [id, page] of this.pages) {
      const active = this.activePageIds.has(id) ? " [LOADED]" : "";
      lines.push(`  ${id}: ${page.label} (${page.tokens} tok, ${page.messageCount} msgs)${active}`);
    }
    return lines.join("\n");
  }

  /**
   * Build active page content — the full content of loaded pages.
   */
  private buildActivePages(): string {
    const sections: string[] = [];
    let totalTokens = 0;

    for (const pageId of this.activePageIds) {
      const page = this.loadPage(pageId);
      if (!page) continue;

      if (totalTokens + page.tokens > this.config.activePageTokens) {
        sections.push(`[Page ${pageId} skipped — would exceed active page budget]`);
        continue;
      }

      sections.push(`--- Page: ${pageId} (${page.label}) ---\n${page.content}\n--- End Page ---`);
      totalTokens += page.tokens;
    }

    return sections.join("\n\n");
  }

  /**
   * Override messages() to implement the virtual memory paging.
   * Returns: system prompt + page index + active pages + recent messages window.
   */
  override messages(): ChatMessage[] {
    // Process pending refs/unrefs
    for (const id of this.pendingRefs) {
      this.activePageIds.add(id);
    }
    for (const id of this.pendingUnrefs) {
      this.activePageIds.delete(id);
    }
    this.pendingRefs.clear();
    this.pendingUnrefs.clear();

    const result: ChatMessage[] = [];
    let usedTokens = 0;

    // 1. System prompt (always first)
    const sysMsg = this.messagesBuffer.find(m => m.role === "system");
    if (sysMsg) {
      result.push(sysMsg);
      usedTokens += this.messageTokens([sysMsg]);
    }

    // 2. Page index (if we have pages)
    const indexContent = this.buildPageIndex();
    if (indexContent) {
      const indexTokens = this.estimateTokens(indexContent);
      if (indexTokens <= this.config.indexTokens) {
        result.push({
          role: "system",
          from: "VirtualMemory",
          content: indexContent,
        });
        usedTokens += indexTokens;
      }
    }

    // 3. Active pages
    const activePagesContent = this.buildActivePages();
    if (activePagesContent) {
      const apTokens = this.estimateTokens(activePagesContent);
      result.push({
        role: "system",
        from: "VirtualMemory",
        content: activePagesContent,
      });
      usedTokens += apTokens;
    }

    // 4. Recent messages — fill remaining budget
    const remainingBudget = this.config.windowTokens - usedTokens;
    const nonSystemMsgs = this.messagesBuffer.filter(m => m.role !== "system" || m !== sysMsg);

    // Walk backwards to fill the window
    const window: ChatMessage[] = [];
    let windowTokens = 0;

    for (let i = nonSystemMsgs.length - 1; i >= 0; i--) {
      const msg = nonSystemMsgs[i];
      const msgTokens = this.messageTokens([msg]);

      if (windowTokens + msgTokens > remainingBudget && window.length >= this.config.minRecentMessages) {
        break;
      }

      window.unshift(msg);
      windowTokens += msgTokens;

      // Hard stop — even minRecentMessages can't exceed 2x budget
      if (windowTokens > remainingBudget * 2) break;
    }

    result.push(...window);
    return result;
  }

  // --- Lifecycle ---

  protected async onAfterAdd(): Promise<void> {
    // No background summarization — page creation is explicit or triggered by the runtime
  }

  // --- Accessors ---

  getPages(): ContextPage[] {
    return Array.from(this.pages.values());
  }

  getActivePageIds(): string[] {
    return Array.from(this.activePageIds);
  }

  getPageCount(): number {
    return this.pages.size;
  }

  hasPage(pageId: string): boolean {
    return this.pages.has(pageId);
  }
}

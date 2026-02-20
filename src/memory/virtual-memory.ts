import type { ChatDriver, ChatMessage } from "../drivers/types.js";
import { AgentMemory } from "./agent-memory.js";
import { saveSession, loadSession, ensureGroDir } from "../session.js";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { SummarizationQueue } from "./summarization-queue.js";
import { BatchWorkerManager } from "./batch-worker-manager.js";
import { Logger } from "../logger.js";

// Load summarizer system prompt from markdown file (next to this module)
const __dirname = dirname(fileURLToPath(import.meta.url));
const SUMMARIZER_PROMPT_PATH = join(__dirname, "summarizer-prompt.md");
let _summarizerPromptBase: string | null = null;
function getSummarizerPromptBase(): string {
  if (_summarizerPromptBase === null) {
    try {
      _summarizerPromptBase = readFileSync(SUMMARIZER_PROMPT_PATH, "utf-8").trim();
    } catch {
      // Fallback if file is missing
      _summarizerPromptBase = "You are a precise summarizer. Output concise bullet points preserving facts, tasks, file paths, commands, and decisions. Messages marked @@important@@ MUST be reproduced verbatim. Messages marked @@ephemeral@@ can be omitted entirely.";
    }
  }
  return _summarizerPromptBase;
}

/**
 * VirtualMemory — paged context with inline refs, independent budgets, and swimlane awareness.
 *
 * Buffer layout:
 *   [system prompt]
 *   [page slot — reserved budget for loaded pages]
 *   [working memory — recent messages, older ones fade to summaries with embedded refs]
 *
 * When working memory exceeds its budget, messages are partitioned into swimlanes
 * (assistant/user/system/tool) and processed independently:
 * 1. Recent messages from each lane are preserved (minRecentPerLane)
 * 2. Older messages from each lane are saved as immutable pages on disk
 * 3. Each lane's paged messages are replaced with a compact summary containing inline  links
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
  /** Max importance weight of messages in this page (0.0–1.0) */
  maxImportance?: number;
}

export interface VirtualMemoryConfig {
  /** Directory for page storage (default: ~/.gro/pages/) */
  pagesDir?: string;
  /** Token budget for the page slot (loaded pages) */
  pageSlotTokens?: number;
  /** Token budget for working memory (recent messages + summaries) */
  workingMemoryTokens?: number;
  /** Weight for assistant lane (auto-normalized) */
  assistantWeight?: number;
  /** Weight for user lane (auto-normalized) */
  userWeight?: number;
  /** Weight for system lane (auto-normalized) */
  systemWeight?: number;
  /** Weight for tool lane (auto-normalized) */
  toolWeight?: number;
  /** Characters per token estimate */
  avgCharsPerToken?: number;
  /** Minimum recent messages to keep per lane (never summarize) */
  minRecentPerLane?: number;
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
  /** Enable async batch summarization (50% cost savings, 5min-24hr latency) */
  enableBatchSummarization?: boolean;
  /** Path to summarization queue (default: ~/.gro/summarization-queue.jsonl) */
  queuePath?: string;
}

const DEFAULTS = {
  pagesDir: join(process.env.HOME ?? "/tmp", ".gro", "pages"),
  pageSlotTokens: 30_000,
  workingMemoryTokens: 30_000,
  assistantWeight: 8,
  userWeight: 4,
  systemWeight: 3,
  toolWeight: 1,
  avgCharsPerToken: 2.8,
  minRecentPerLane: 4,
  highRatio: 0.75,
  lowRatio: 0.50,
  systemPrompt: "",
  summarizerModel: "claude-haiku-4-5",
  enableBatchSummarization: false,
  queuePath: join(process.env.HOME ?? "/tmp", ".gro", "summarization-queue.jsonl"),
};

// --- VirtualMemory ---

/** Messages with importance >= this threshold are promoted to the keep set during paging */
const IMPORTANCE_KEEP_THRESHOLD = 0.7;

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
  /** Summarization queue (if batch mode enabled) */
  private summaryQueue: SummarizationQueue | null = null;
  /** Batch worker manager (spawns background worker if batch mode enabled) */
  private batchWorkerManager: BatchWorkerManager | null = null;

  constructor(config: VirtualMemoryConfig = {}) {
    super(config.systemPrompt);
    this.cfg = {
      pagesDir: config.pagesDir ?? DEFAULTS.pagesDir,
      pageSlotTokens: config.pageSlotTokens ?? DEFAULTS.pageSlotTokens,
      workingMemoryTokens: config.workingMemoryTokens ?? DEFAULTS.workingMemoryTokens,
      assistantWeight: config.assistantWeight ?? DEFAULTS.assistantWeight,
      userWeight: config.userWeight ?? DEFAULTS.userWeight,
      systemWeight: config.systemWeight ?? DEFAULTS.systemWeight,
      toolWeight: config.toolWeight ?? DEFAULTS.toolWeight,
      avgCharsPerToken: config.avgCharsPerToken ?? DEFAULTS.avgCharsPerToken,
      minRecentPerLane: config.minRecentPerLane ?? DEFAULTS.minRecentPerLane,
      highRatio: config.highRatio ?? DEFAULTS.highRatio,
      lowRatio: config.lowRatio ?? DEFAULTS.lowRatio,
      systemPrompt: config.systemPrompt ?? DEFAULTS.systemPrompt,
      driver: config.driver ?? null,
      summarizerModel: config.summarizerModel ?? DEFAULTS.summarizerModel,
      enableBatchSummarization: config.enableBatchSummarization ?? DEFAULTS.enableBatchSummarization,
      queuePath: config.queuePath ?? DEFAULTS.queuePath,
    };
    mkdirSync(this.cfg.pagesDir, { recursive: true });
    // Initialize summarization queue if batch mode enabled
    if (this.cfg.enableBatchSummarization) {
      this.summaryQueue = new SummarizationQueue(this.cfg.queuePath);
      this.startBatchWorker();
    }
  }

  override setModel(model: string): void {
    this.model = model;
  }

  /**
   * Adjust compaction aggressiveness based on the current thinking budget.
   *
   * Low budget (cheap model, small context) → compact aggressively, keep less.
   * High budget (expensive model, big context) → keep more history for richer reasoning.
   *
   * Scales workingMemoryTokens, highRatio, and minRecentPerLane around their
   * configured baselines. Called each round from the execution loop.
   */
  private baseWorkingMemoryTokens: number | null = null;
  private baseHighRatio: number | null = null;
  private baseMinRecentPerLane: number | null = null;

  override setThinkingBudget(budget: number): void {
    // Capture baselines on first call
    if (this.baseWorkingMemoryTokens === null) {
      this.baseWorkingMemoryTokens = this.cfg.workingMemoryTokens;
      this.baseHighRatio = this.cfg.highRatio;
      this.baseMinRecentPerLane = this.cfg.minRecentPerLane;
    }

    // Scale factor: 0.6x at budget=0, 1.0x at budget=0.5, 1.6x at budget=1.0
    const scale = 0.6 + budget * 1.0;

    // Working memory: scale token budget (cheap models get less context)
    this.cfg.workingMemoryTokens = Math.round(this.baseWorkingMemoryTokens * scale);

    // High watermark: lower = more aggressive compaction
    // At budget=0: 0.55 (compact early). At budget=1: 0.90 (keep more before compacting)
    this.cfg.highRatio = Math.min(0.95, this.baseHighRatio! * (0.75 + budget * 0.5));

    // Min recent per lane: keep fewer messages on cheap models
    // At budget=0: 2. At budget=0.5: 4 (default). At budget=1: 6.
    this.cfg.minRecentPerLane = Math.max(2, Math.round(this.baseMinRecentPerLane! * scale));
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

  /**
   * Force immediate context compaction regardless of watermark level.
   * Use before starting a large task when you want to free up working memory.
   * Returns a summary of what was compacted.
   */
  async forceCompact(): Promise<string> {
    if (!this.cfg.driver) {
      return "Error: no driver configured, cannot compact";
    }

    const before = this.messagesBuffer.filter(m => m.role !== "system");
    const beforeTokens = this.msgTokens(before);
    const beforeCount = before.length;

    if (beforeCount === 0) {
      return "Nothing to compact — context is empty.";
    }

    // Set flag so onAfterAdd bypasses watermark check this one time.
    this.forceCompactPending = true;
    // Trigger via add of a no-op system note (drives onAfterAdd).
    // We'll remove it immediately after compaction.
    const noop: import("../drivers/types.js").ChatMessage = {
      role: "system",
      content: "<!-- compact -->",
      from: "System",
    };
    this.messagesBuffer.push(noop);
    await this.onAfterAdd();
    // Remove the noop message
    const idx = this.messagesBuffer.indexOf(noop);
    if (idx !== -1) this.messagesBuffer.splice(idx, 1);

    const after = this.messagesBuffer.filter(m => m.role !== "system");
    const afterTokens = this.msgTokens(after);
    const afterCount = after.length;
    const pageCount = this.getPageCount();

    return `Compacted: ${beforeCount} → ${afterCount} messages, ${beforeTokens} → ${afterTokens} tokens. Total pages: ${pageCount}.`;
  }

  private forceCompactPending = false;

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

  /** Normalize weights and compute per-lane token budgets */
  private computeLaneBudgets(): {
    assistant: number;
    user: number;
    system: number;
    tool: number;
  } {
    const totalWeight = this.cfg.assistantWeight + this.cfg.userWeight + this.cfg.systemWeight + this.cfg.toolWeight;
    const wmBudget = this.cfg.workingMemoryTokens;

    return {
      assistant: Math.floor((this.cfg.assistantWeight / totalWeight) * wmBudget),
      user: Math.floor((this.cfg.userWeight / totalWeight) * wmBudget),
      system: Math.floor((this.cfg.systemWeight / totalWeight) * wmBudget),
      tool: Math.floor((this.cfg.toolWeight / totalWeight) * wmBudget),
    };
  }

  private msgTokens(msgs: ChatMessage[]): number {
    let chars = 0;
    for (const m of msgs) {
      const s = String(m.content ?? "");
      // No per-message cap — use full length for accurate estimation.
      // A cap here caused severe under-counting: a 300K-char tool output was
      // estimated as ~8K tokens but sent ~107K actual tokens, allowing 7+ such
      // messages through the wmBudget * 2 window guard → context_length_exceeded.
      chars += s.length + 32;
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
    lane?: "assistant" | "user" | "system",
  ): Promise<{ page: ContextPage; summary: string }> {
    // Build raw content for the page
    const rawContent = messages.map(m =>
      `[${m.role}${m.from ? ` (${m.from})` : ""}]: ${String(m.content ?? "").slice(0, 8000)}`
    ).join("\n\n");

    // Track max importance across messages in this page
    const maxImportance = messages.reduce(
      (max, m) => Math.max(max, m.importance ?? 0), 0
    );

    const page: ContextPage = {
      id: this.generatePageId(rawContent),
      label,
      content: rawContent,
      createdAt: new Date().toISOString(),
      messageCount: messages.length,
      tokens: this.tokensFor(rawContent),
      ...(maxImportance > 0 ? { maxImportance } : {}),
    };
    this.savePage(page);

    // Generate summary with embedded ref
    let summary: string;
    if (this.cfg.enableBatchSummarization && this.summaryQueue) {
      // Queue page for async batch summarization
      this.summaryQueue.enqueue({
        pageId: page.id,
        label,
        lane,
        queuedAt: Date.now(),
      });
      // Return placeholder summary immediately (non-blocking)
      summary = `[Pending summary: ${messages.length} messages, ${label}] `;
    } else if (this.cfg.driver) {
      summary = await this.summarizeWithRef(messages, page.id, label, lane);
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
    lane?: "assistant" | "user" | "system",
  ): Promise<string> {
    // Extract importance-tagged content for special handling
    const importantLines: string[] = [];
    const transcript = messages.map(m => {
      const raw = String(m.content ?? "");
      // Hard-strip @@ephemeral@@ lines before summarization
      const stripped = raw.split("\n")
        .filter(line => !/@@ephemeral@@/i.test(line))
        .join("\n");
      const c = stripped.slice(0, 4000);
      // Collect @@important@@ lines verbatim for the summarizer header
      for (const line of raw.split("\n")) {
        if (/@@important@@/i.test(line)) {
          importantLines.push(line.replace(/@@important@@/gi, "").trim());
        }
      }
      // Tag messages with importance field for the summarizer
      const imp = (m.importance ?? 0) >= IMPORTANCE_KEEP_THRESHOLD
        ? ` [IMPORTANT=${m.importance}]` : "";
      return `${m.role.toUpperCase()}${imp}: ${c}`;
    }).join("\n");

    const importantNote = importantLines.length > 0
      ? `\n\nIMPORTANT — preserve these verbatim in the summary:\n${importantLines.map(l => `  • ${l}`).join("\n")}`
      : "";

    const laneNote = lane
      ? `\n\n## Active Lane: ${lane}\nApply the lane-specific focus rules for the "${lane}" lane from the rules above.`
      : "";

    const sys: ChatMessage = {
      role: "system",
      from: "System",
      content: getSummarizerPromptBase() + laneNote,
    };

    const usr: ChatMessage = {
      role: "user",
      from: "User",
      content: `Summarize this conversation segment (${label}):${importantNote}\n\n${transcript.slice(0, 12000)}`,
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
      if (wmTokens + mt > wmBudget && window.length >= this.cfg.minRecentPerLane * 4) break;
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

  // --- Importance-Aware Partitioning ---

  /**
   * Split a lane's messages into "page out" and "keep" sets, respecting importance.
   * Messages with importance >= IMPORTANCE_KEEP_THRESHOLD are always kept (promoted),
   * plus the most recent tailN messages. Everything else gets paged out.
   */
  private partitionByImportance(
    messages: ChatMessage[],
    tailN: number,
    shouldPage: boolean,
  ): { older: ChatMessage[]; keep: ChatMessage[] } {
    if (!shouldPage) return { older: [], keep: messages };

    // Start with the tail (most recent) as the base keep set
    const cutoff = Math.max(0, messages.length - tailN);
    const candidatesForPaging = messages.slice(0, cutoff);
    const recentKeep = messages.slice(cutoff);

    // Promote high-importance messages from the paging candidates
    const older: ChatMessage[] = [];
    const promoted: ChatMessage[] = [];
    for (const m of candidatesForPaging) {
      if ((m.importance ?? 0) >= IMPORTANCE_KEEP_THRESHOLD) {
        promoted.push(m);
      } else {
        older.push(m);
      }
    }

    // Combine promoted + recent, preserving original order
    const keepSet = new Set([...promoted, ...recentKeep]);
    const keep = messages.filter(m => keepSet.has(m));

    return { older, keep };
  }

  // --- Swimlane Partitioning ---

  /**
   * Partition messages into swimlanes by role, respecting the first system message.
   * Similar to AdvancedMemory's approach.
   */
  private partition() {
    const assistant: ChatMessage[] = [];
    const user: ChatMessage[] = [];
    const system: ChatMessage[] = [];
    const tool: ChatMessage[] = [];
    const other: ChatMessage[] = [];

    for (const m of this.messagesBuffer) {
      switch (m.role) {
        case "assistant": assistant.push(m); break;
        case "user": user.push(m); break;
        case "system": system.push(m); break;
        case "tool": tool.push(m); break;
        default: other.push(m); break;
      }
    }

    const firstSystemIndex = this.messagesBuffer.findIndex(x => x.role === "system");
    return { firstSystemIndex, assistant, user, system, tool, other };
  }

  // --- Background Summarization ---

  /**
   * Find a safe boundary for chunking messages that doesn't split tool call/result pairs.
   * Scans backward from the proposed chunkSize to find a position where the next message
   * is NOT a tool result (role !== "tool"), ensuring we don't orphan tool messages.
   */
  private findSafeBoundary(messages: ChatMessage[], proposedSize: number): number {
    if (proposedSize >= messages.length) return proposedSize;
    if (proposedSize === 0) return 0;

    // Scan backward from proposed boundary to find a safe split point
    for (let i = proposedSize; i > 0; i--) {
      // Check if the message immediately after position i is a tool message
      if (i < messages.length && messages[i].role === "tool") {
        // Not safe - this would orphan tool results. Try one position earlier.
        continue;
      }
      // Safe boundary found
      return i;
    }

    // Fallback: if we can't find a safe boundary, take minimum chunk (2 messages)
    // This ensures we always make progress even if the entire buffer is tool messages
    return Math.min(2, proposedSize);
  }

  protected async onAfterAdd(): Promise<void> {
    if (!this.cfg.driver) return;

    // Compute normalized per-lane budgets
    const budgets = this.computeLaneBudgets();

    // Partition messages to check per-lane budgets
    const { assistant, user, system, tool } = this.partition();

    // Calculate per-lane token usage
    const assistantTokens = this.msgTokens(assistant);
    const userTokens = this.msgTokens(user);
    const systemTokens = this.msgTokens(system.slice(1)); // Exclude system prompt
    const toolTokens = this.msgTokens(tool);

    // Check if any lane exceeds its budget
    const assistantOverBudget = assistantTokens > budgets.assistant * this.cfg.highRatio;
    const userOverBudget = userTokens > budgets.user * this.cfg.highRatio;
    const systemOverBudget = systemTokens > budgets.system * this.cfg.highRatio;
    // Tool lane always pages with assistant to avoid orphaning tool calls/results
    const toolOverBudget = assistantOverBudget;

    // VM diagnostics logging (if GRO_VM_DEBUG=true)
    if (process.env.GRO_VM_DEBUG === "true") {
      Logger.info(`[VM] A:${assistantTokens}/${budgets.assistant} U:${userTokens}/${budgets.user} S:${systemTokens}/${budgets.system} T:${toolTokens}/${budgets.tool} paging=[A:${assistantOverBudget} U:${userOverBudget} S:${systemOverBudget} T:${toolOverBudget}]`);
    }

    // If no lane is over budget, nothing to do (unless forced)
    const forced = this.forceCompactPending;
    this.forceCompactPending = false;
    if (!forced && !assistantOverBudget && !userOverBudget && !systemOverBudget) return;

    await this.runOnce(async () => {
      // Compute normalized budgets
      const budgets = this.computeLaneBudgets();

      // Re-partition to get fresh data
      const { firstSystemIndex, assistant, user, system, tool, other } = this.partition();
      const tailN = this.cfg.minRecentPerLane;

      // Calculate metrics before cleanup
      const nonSys = this.messagesBuffer.filter(m => m.role !== "system");
      const beforeTokens = this.msgTokens(nonSys);
      const beforeMB = (beforeTokens * this.cfg.avgCharsPerToken / 1024 / 1024).toFixed(2);
      const beforeMsgCount = nonSys.length;

      // Protect the original system prompt (set by constructor, identified by from === "System").
      // Cannot rely on firstSystemIndex === 0 because after compaction, summaries are prepended
      // and the system prompt may no longer be at index 0.
      const originalSysPrompt = this.messagesBuffer.find(m => m.role === "system" && m.from === "System");
      const sysHead = originalSysPrompt ? [originalSysPrompt] : [];
      const remainingSystem = system.filter(m => m !== originalSysPrompt);

      // Recalculate per-lane token usage
      const assistantTok = this.msgTokens(assistant);
      const userTok = this.msgTokens(user);
      const systemTok = this.msgTokens(remainingSystem);
      const toolTok = this.msgTokens(tool);

      // Determine which lanes to page based on normalized budget (forced = page all non-empty lanes)
      const shouldPageAssistant = forced ? assistant.length > tailN : assistantTok > budgets.assistant * this.cfg.highRatio;
      const shouldPageUser = forced ? user.length > tailN : userTok > budgets.user * this.cfg.highRatio;
      const shouldPageSystem = forced ? remainingSystem.length > 0 : systemTok > budgets.system * this.cfg.highRatio;
      // CRITICAL: Tool lane MUST page with assistant lane to avoid orphaning tool calls/results
      // Tool results (tool lane) must stay paired with their tool calls (assistant lane)
      const shouldPageTool = shouldPageAssistant;

      // Determine which messages to page out vs keep per lane.
      // High-importance messages (>= IMPORTANCE_KEEP_THRESHOLD) are promoted to
      // the keep set even if they're older than the tail window.
      const { older: olderAssistant, keep: keepAssistant } =
        this.partitionByImportance(assistant, tailN, shouldPageAssistant);
      const { older: olderUser, keep: keepUser } =
        this.partitionByImportance(user, tailN, shouldPageUser);
      const { older: olderSystem, keep: keepSystem } =
        this.partitionByImportance(remainingSystem, tailN, shouldPageSystem);
      const { older: olderTool, keep: keepTools } =
        this.partitionByImportance(tool, tailN, shouldPageTool);

      // Create pages for each lane with older messages
      const summaries: ChatMessage[] = [];

      if (olderAssistant.length >= 2) {
        const label = `assistant lane ${new Date().toISOString().slice(0, 16)} (${olderAssistant.length} msgs)`;
        const { summary } = await this.createPageFromMessages(olderAssistant, label, "assistant");
        summaries.push({
          role: "assistant",
          from: "VirtualMemory",
          content: `ASSISTANT LANE SUMMARY:\n${summary}`,
        });
      }

      if (olderUser.length >= 2) {
        const label = `user lane ${new Date().toISOString().slice(0, 16)} (${olderUser.length} msgs)`;
        const { summary } = await this.createPageFromMessages(olderUser, label, "user");
        summaries.push({
          role: "user",
          from: "VirtualMemory",
          content: `USER LANE SUMMARY:\n${summary}`,
        });
      }

      if (olderSystem.length >= 2) {
        const label = `system lane ${new Date().toISOString().slice(0, 16)} (${olderSystem.length} msgs)`;
        const { summary } = await this.createPageFromMessages(olderSystem, label, "system");
        summaries.push({
          role: "system",
          from: "VirtualMemory",
          content: `SYSTEM LANE SUMMARY:\n${summary}`,
        });
      }

      if (olderTool.length >= 2) {
        const label = `tool lane ${new Date().toISOString().slice(0, 16)} (${olderTool.length} msgs)`;
        const { summary } = await this.createPageFromMessages(olderTool, label);
        summaries.push({
          role: "system",
          from: "VirtualMemory",
          content: `TOOL LANE SUMMARY:\n${summary}`,
        });
      }

      // Rebuild message buffer: summaries + system prompt + recent messages from each lane
      // We need to preserve the original message order for kept messages
      const keptSet = new Set([
        ...sysHead,
        ...keepAssistant,
        ...keepUser,
        ...keepSystem,
        ...keepTools,
        ...other,
      ]);

      const orderedKept: ChatMessage[] = [];
      for (const m of this.messagesBuffer) {
        if (keptSet.has(m)) orderedKept.push(m);
      }

      // Insert summaries at the beginning (after system prompt if present)
      const rebuilt: ChatMessage[] = [...summaries, ...orderedKept];
      this.messagesBuffer.splice(0, this.messagesBuffer.length, ...rebuilt);

      // Calculate metrics after cleanup
      const afterNonSys = this.messagesBuffer.filter(m => m.role !== "system");
      const afterTokens = this.msgTokens(afterNonSys);
      const afterMB = (afterTokens * this.cfg.avgCharsPerToken / 1024 / 1024).toFixed(2);
      const afterMsgCount = afterNonSys.length;
      const reclaimedMB = (parseFloat(beforeMB) - parseFloat(afterMB)).toFixed(2);

      // Log cleanup event with per-lane paging info
      Logger.info(`[VM cleaned] before=${beforeMB}MB after=${afterMB}MB reclaimed=${reclaimedMB}MB messages=${beforeMsgCount}→${afterMsgCount} paged=[A:${olderAssistant.length} U:${olderUser.length} S:${olderSystem.length} T:${olderTool.length}]`);
    });
  }

  // --- Accessors ---

  getPages(): ContextPage[] { return Array.from(this.pages.values()); }
  getActivePageIds(): string[] { return Array.from(this.activePageIds); }
  getPageCount(): number { return this.pages.size; }
  hasPage(id: string): boolean { return this.pages.has(id); }

  /**
   * Start the batch worker subprocess.
   */
  private startBatchWorker(): void {
    // Only start if driver is available (we need API key)
    if (!this.cfg.driver) {
      Logger.warn("[VirtualMemory] Cannot start batch worker: driver not configured");
      return;
    }

    // Extract API key from driver (assumes AnthropicDriver)
    const apiKey = (this.cfg.driver as any).apiKey;
    if (!apiKey) {
      Logger.warn("[VirtualMemory] Cannot start batch worker: API key not found in driver");
      return;
    }

    this.batchWorkerManager = new BatchWorkerManager({
      queuePath: this.cfg.queuePath,
      pagesDir: this.cfg.pagesDir,
      apiKey,
      pollInterval: 60000,
      batchPollInterval: 300000,
      batchSize: 10000,
      model: this.cfg.summarizerModel,
    });

    this.batchWorkerManager.start();
    Logger.info("[VirtualMemory] Batch worker started");
  }

  /**
   * Stop the batch worker subprocess (if running).
   */
  private stopBatchWorker(): void {
    if (this.batchWorkerManager) {
      this.batchWorkerManager.stop();
      this.batchWorkerManager = null;
    }
  }
}

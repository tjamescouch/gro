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
import { PhantomBuffer, type PhantomSnapshot } from "./phantom-buffer.js";
import { MemoryMetricsCollector } from "./memory-metrics.js";

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
      _summarizerPromptBase = "You are a precise summarizer. Output concise bullet points preserving facts, tasks, file paths, commands, and decisions. Messages marked 🧠 MUST be reproduced verbatim. Messages marked 🧠 can be omitted entirely.";
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
  /** Session ID for scoping pages to per-session dir (default: global) */
  sessionId?: string;
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
  /** Enable phantom compaction (fork-based perfect recall) */
  enablePhantomCompaction?: boolean;
}

const DEFAULTS = {
  pagesDir: join(process.env.HOME ?? "/tmp", ".gro", "pages"),
  pageSlotTokens: parseInt(process.env.GRO_PAGE_SLOT_TOKENS ?? "6000"),
  workingMemoryTokens: parseInt(process.env.GRO_WORKING_MEMORY_TOKENS ?? "6000"),
  assistantWeight: parseInt(process.env.GRO_ASSISTANT_WEIGHT ?? "8"),
  userWeight: parseInt(process.env.GRO_USER_WEIGHT ?? "4"),
  systemWeight: parseInt(process.env.GRO_SYSTEM_WEIGHT ?? "3"),
  toolWeight: parseInt(process.env.GRO_TOOL_WEIGHT ?? "1"),
  avgCharsPerToken: parseFloat(process.env.GRO_AVG_CHARS_PER_TOKEN ?? "2.8"),
  minRecentPerLane: parseInt(process.env.GRO_MIN_RECENT_PER_LANE ?? "4"),
  highRatio: parseFloat(process.env.GRO_HIGH_RATIO ?? "0.75"),
  lowRatio: parseFloat(process.env.GRO_LOW_RATIO ?? "0.50"),
  systemPrompt: "",
  summarizerModel: "claude-haiku-4-5",
  enableBatchSummarization: false,
  enablePhantomCompaction: process.env.GRO_PHANTOM_COMPACTION === "true",
  queuePath: join(process.env.HOME ?? "/tmp", ".gro", "summarization-queue.jsonl"),
  sessionId: "",
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

  /** Frequency counter — tracks how many times each page is referenced */
  private pageRefCount: Map<string, number> = new Map();

  /** Pinned pages — never evicted */
  private pinnedPageIds: Set<string> = new Set();

  private model = "unknown";
  /** Summarization queue (if batch mode enabled) */
  private summaryQueue: SummarizationQueue | null = null;
  /** Batch worker manager (spawns background worker if batch mode enabled) */
  private batchWorkerManager: BatchWorkerManager | null = null;
  // Phantom compaction state
  private phantomBuffer: PhantomBuffer | null = null;
  // Memory performance instrumentation
  private metricsCollector: MemoryMetricsCollector | null = null;


  constructor(config: VirtualMemoryConfig = {}) {
    super(config.systemPrompt);
    const pagesDir = config.sessionId 
      ? join(DEFAULTS.pagesDir, config.sessionId) 
      : (config.pagesDir ?? DEFAULTS.pagesDir);
    this.cfg = {
      pagesDir,
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
      enablePhantomCompaction: config.enablePhantomCompaction ?? DEFAULTS.enablePhantomCompaction,
      queuePath: config.queuePath ?? DEFAULTS.queuePath,
      sessionId: config.sessionId ?? DEFAULTS.sessionId,
    };
    mkdirSync(this.cfg.pagesDir, { recursive: true });
    // Initialize summarization queue if batch mode enabled
    if (this.cfg.enableBatchSummarization) {
      this.summaryQueue = new SummarizationQueue(this.cfg.queuePath);
      this.startBatchWorker();
    }
    // Initialize phantom buffer if enabled
    if (this.cfg.enablePhantomCompaction) {
      this.phantomBuffer = new PhantomBuffer({ avgCharsPerToken: this.cfg.avgCharsPerToken });
    
    // Initialize metrics collector
    const sessionId = process.env.GRO_SESSION_ID || `session-${Date.now()}`;
    const metricsPath = join(this.cfg.pagesDir, "memory-metrics.json");
    this.metricsCollector = new MemoryMetricsCollector(sessionId, metricsPath);
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
    this.cfg.minRecentPerLane = Math.max(2, Math.round(this.baseMinRecentPerLane! * scale));
  }

  /**
   * Hot-tune VirtualMemory parameters at runtime.
   * Supports: working, page, high, low, min_recent, assistant_weight, etc.
   * Example: tune({ working: 8000, page: 6000 })
   */
  tune(params: { [key: string]: number }): void {
    const keys = Object.keys(params);
    for (const key of keys) {
      const val = params[key];
      if (val <= 0) continue; // Ignore non-positive values
      switch (key.toLowerCase()) {
        case "working":
        case "working_memory":
        case "workingmemory":
          this.cfg.workingMemoryTokens = val;
          this.baseWorkingMemoryTokens = val;
          Logger.info(`VirtualMemory: workingMemoryTokens → ${val}`);
          break;
        case "page":
        case "page_slot":
        case "pageslot":
          this.cfg.pageSlotTokens = val;
          Logger.info(`VirtualMemory: pageSlotTokens → ${val}`);
          break;
        case "high":
        case "high_ratio":
          if (val >= 0 && val <= 1) {
            this.cfg.highRatio = val;
            Logger.info(`VirtualMemory: highRatio → ${val}`);
          }
          break;
        case "low":
        case "low_ratio":
          if (val >= 0 && val <= 1) {
            this.cfg.lowRatio = val;
            Logger.info(`VirtualMemory: lowRatio → ${val}`);
          }
          break;
        case "min_recent":
        case "minrecent":
          if (val >= 1) {
            this.cfg.minRecentPerLane = Math.round(val);
            Logger.info(`VirtualMemory: minRecentPerLane → ${Math.round(val)}`);
          }
          break;
        case "assistant_weight":
        case "assistantweight":
          this.cfg.assistantWeight = val;
          Logger.info(`VirtualMemory: assistantWeight → ${val}`);
          break;
        case "user_weight":
        case "userweight":
          this.cfg.userWeight = val;
          Logger.info(`VirtualMemory: userWeight → ${val}`);
          break;
        case "system_weight":
        case "systemweight":
          this.cfg.systemWeight = val;
          Logger.info(`VirtualMemory: systemWeight → ${val}`);
          break;
        case "tool_weight":
        case "toolweight":
          this.cfg.toolWeight = val;
          Logger.info(`VirtualMemory: toolWeight → ${val}`);
          break;
       default:
         Logger.warn(`VirtualMemory.tune: unknown parameter '${key}'`);
     }
   }
 }

  /**
   * Hot-reload memory configuration from marker (e.g. @@working:8k,page:12k@@).
   * Parses numeric k-suffix (e.g. "8k" → 8000) and applies to working/page token budgets.
   * Does NOT trigger compaction — preserves all loaded pages.
   */
  hotReloadConfig(config: { workingMemoryTokens?: number; pageSlotTokens?: number }): string {
    const changes: string[] = [];

    if (config.workingMemoryTokens !== undefined) {
      const old = this.cfg.workingMemoryTokens;
      this.cfg.workingMemoryTokens = config.workingMemoryTokens;
      this.baseWorkingMemoryTokens = config.workingMemoryTokens; // Reset baseline
      changes.push(`workingMemoryTokens: ${old} → ${config.workingMemoryTokens}`);
    }
    if (config.pageSlotTokens !== undefined) {
      const old = this.cfg.pageSlotTokens;
      this.cfg.pageSlotTokens = config.pageSlotTokens;
      changes.push(`pageSlotTokens: ${old} → ${config.pageSlotTokens}`);
    }
    return changes.length > 0 ? changes.join("; ") : "No config changes";
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

  // --- Phantom Compaction API ---

  /**
   * Get phantom buffer status (memory usage, snapshots).
   */
  getPhantomStatus(): ReturnType<PhantomBuffer["getMemoryUsage"]> | null {
    return this.phantomBuffer?.getMemoryUsage() ?? null;
  }

  /**
   * List available phantom snapshots.
   */
  listPhantomSnapshots(): ReturnType<PhantomBuffer["listSnapshots"]> {
    return this.phantomBuffer?.listSnapshots() ?? [];
  }

  /**
   * Recall (inject) a phantom snapshot into working memory.
   * Returns the snapshot messages or null if not found/disabled.
   */
  recallPhantom(snapshotId?: string): ChatMessage[] | null {
    if (!this.phantomBuffer) return null;

    const snap = snapshotId
      ? this.phantomBuffer.getSnapshot(snapshotId)
      : this.phantomBuffer.getLatest();

    return snap?.messages ?? null;
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
      this.pageRefCount = new Map(data.pageRefCount ?? []);
      this.pinnedPageIds = new Set(data.pinnedPageIds ?? []);
    } catch {
      this.pages.clear();
    }
  }


  private savePageIndex(): void {
    try {
      mkdirSync(this.cfg.pagesDir, { recursive: true });
      writeFileSync(this.indexPath(), JSON.stringify({
        pages: Array.from(this.pages.values()),
        activePageIds: Array.from(this.activePageIds),
        loadOrder: this.loadOrder,
        pageRefCount: Array.from(this.pageRefCount.entries()),
        pinnedPageIds: Array.from(this.pinnedPageIds),
        savedAt: new Date().toISOString(),
      }, null, 2) + "\n");
    } catch (err) {
      Logger.error(`[VirtualMemory] Failed to save page index to ${this.indexPath()}: ${err}`);
    }
  }

  // --- Page Storage ---

  private pagePath(id: string): string {
    return join(this.cfg.pagesDir, `${id}.json`);
  }

  private savePage(page: ContextPage): void {
    try {
      mkdirSync(this.cfg.pagesDir, { recursive: true });
      writeFileSync(this.pagePath(page.id), JSON.stringify(page, null, 2) + "\n");
      this.pages.set(page.id, page);
    } catch (err) {
      Logger.error(`[VirtualMemory] Failed to save page ${page.id} to ${this.pagePath(page.id)}: ${err}`);
    }
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
    } catch (err) {
      Logger.error(`[VirtualMemory] Failed to load page ${id} from ${p}: ${err}`);
      return null;
    }
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
      // Include tool_calls arguments in token estimation.
      // Assistant messages with tool_calls often have empty content but large
      // function arguments (e.g. agentchat_send messages, file writes, patches).
      // Without counting these, the windowing loop and compaction triggers
      // massively underestimate assistant message sizes → context_length_exceeded.
      const tc = (m as any).tool_calls;
      if (Array.isArray(tc)) {
        for (const call of tc) {
          const fn = call?.function;
          if (fn) {
            chars += (fn.name?.length ?? 0) + (fn.arguments?.length ?? 0) + 32;
          }
        }
      }
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
    // Track page creation
    if (this.metricsCollector) {
      this.metricsCollector.onPageCreated(page.id, lane ?? 'mixed', page.tokens);
    }

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
      // Hard-strip 🧠 lines before summarization
      const stripped = raw.split("\n")
        .filter(line => !/🧠/i.test(line))
        .join("\n");
      const c = stripped.slice(0, 4000);
      // Collect 🧠 lines verbatim for the summarizer header
      for (const line of raw.split("\n")) {
        if (/🧠/i.test(line)) {
          importantLines.push(line.replace(/🧠/gi, "").trim());
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
      const exists = this.pages.has(id) || existsSync(this.pagePath(id));
      if (exists) {
        this.activePageIds.add(id);
        if (!this.loadOrder.includes(id)) this.loadOrder.push(id);
      }
      // Track reference attempt
      if (this.metricsCollector) {
        this.metricsCollector.onPageReferenced(id, exists);
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

    // Sanitize window front: strip orphan tool results and unpaired assistant tool_calls.
    // When the budget cut severs a tool_call/tool_result pair, the window can start with
    // a 'tool' role message that has no preceding assistant+tool_calls — causing a 400.
    while (window.length > 0) {
      const first = window[0];
      if (first.role === 'tool') {
        // Orphaned tool result — its assistant message was paged out. Drop it.
        window.shift();
      } else if (
        first.role === 'assistant' &&
        Array.isArray((first as any).tool_calls) &&
        (first as any).tool_calls.length > 0
      ) {
        // Dangling tool_calls with no following tool results. Drop it.
        const hasResults = window.length > 1 && window[1].role === 'tool';
        if (!hasResults) {
          window.shift();
        } else {
          break;
        }
      } else {
        break;
      }
    }

    result.push(...window);

    // Safety cap: verify total context size doesn't exceed a hard limit.
    // Even with accurate token estimation, defend against edge cases where
    // system prompt + pages + working memory combine to exceed provider limits.
    const totalTokens = usedTokens + wmTokens;
    const hardCap = wmBudget * 4; // absolute ceiling
    if (totalTokens > hardCap) {
      Logger.warn(`[VM] Total context ${totalTokens} tokens exceeds hard cap ${hardCap} — trimming working memory`);
      const excess = totalTokens - wmBudget * 2; // trim back to 2x budget for safety
      let trimmed = 0;
      // Remove oldest working memory messages (from front of window, after system+pages).
      // Use tool-pair-safe removal: never remove a tool_result without its assistant tool_use,
      // and never remove an assistant tool_use without its subsequent tool_results.
      const wmStart = result.length - window.length;
      while (trimmed < excess && result.length > wmStart + this.cfg.minRecentPerLane * 4) {
        const msg = result[wmStart];
        // If this is an assistant message with tool_calls, remove it AND all following tool results
        const tc = (msg as any).tool_calls;
        if (msg.role === "assistant" && Array.isArray(tc) && tc.length > 0) {
          let groupSize = 1;
          while (wmStart + groupSize < result.length && result[wmStart + groupSize].role === "tool") {
            groupSize++;
          }
          const removed = result.splice(wmStart, groupSize);
          trimmed += this.msgTokens(removed);
        } else if (msg.role === "tool") {
          // Orphaned tool result at start of window — safe to remove
          const removed = result.splice(wmStart, 1);
          trimmed += this.msgTokens(removed);
        } else {
          const removed = result.splice(wmStart, 1);
          trimmed += this.msgTokens(removed);
        }
      }
    }

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
      // Find next candidate for eviction: skip pinned, prefer low-frequency, fall back to LRU
      let evictIdx = -1;
      const FREQUENCY_THRESHOLD = 3; // Pages with >= N refs use frequency eviction

      // Pass 1: Find unpinned page with lowest frequency (if any have been ref'd)
      let lowestFreq = Infinity;
      for (let i = 0; i < this.loadOrder.length; i++) {
        const id = this.loadOrder[i];
        if (this.pinnedPageIds.has(id)) continue; // Skip pinned
        const freq = this.pageRefCount.get(id) ?? 0;
        // Only consider frequency eviction if page has >= FREQUENCY_THRESHOLD refs
        if (freq >= FREQUENCY_THRESHOLD && freq < lowestFreq) {
          lowestFreq = freq;
          evictIdx = i;
        }
      }

      // Pass 2: If no frequency candidate, fall back to LRU (oldest unpinned)
      if (evictIdx === -1) {
        for (let i = 0; i < this.loadOrder.length; i++) {
          const id = this.loadOrder[i];
          if (!this.pinnedPageIds.has(id)) {
            evictIdx = i;
            break;
          }
        }
      }

      // No evictable pages found (all pinned?) — bail to prevent infinite loop
      if (evictIdx === -1) {
        Logger.warn(`[VM evict] All loaded pages are pinned; cannot free space`);
        break;
      }

      const evictId = this.loadOrder[evictIdx];
      this.loadOrder.splice(evictIdx, 1);
      this.activePageIds.delete(evictId);
      const page = this.pages.get(evictId);
      if (page) {
        slotTokens -= page.tokens;
        Logger.debug(`[VM evict] Evicted '${evictId}' (freq=${this.pageRefCount.get(evictId) ?? 0}; freed ${page.tokens} tokens)`);
      }
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
   * Flatten compacted tool calls into plain assistant+tool message pairs.
   *
   * After lane-based compaction, assistant messages with tool_calls may have
   * lost their matching tool results (or vice versa). Instead of inserting
   * synthetic stubs (which still carry tool_calls that OpenAI validates),
   * this converts every broken tool call into:
   *   1. A plain "assistant" message with summarized content + metadata (no tool_calls)
   *   2. A matching "tool" message with the result snippet
   *
   * This eliminates the tool_calls field from compacted messages entirely,
   * so OpenAI's strict "tool must follow tool_calls" rule cannot be violated
   * regardless of how paging fragments message order.
   *
   * Rules:
   * - Properly split pairs (all tool results adjacent) → leave alone
   * - Broken/missing pairs → flatten to summarized assistant + tool
   * - Dangling tool results (no matching tool_calls) → log warning, skip
   */
  private flattenCompactedToolCalls(): void {
    const buf = this.messagesBuffer;

    // --- Pre-index ---

    // Map tool_call_id → tool result message
    const toolResultMap = new Map<string, ChatMessage>();
    for (const m of buf) {
      if (m.role === "tool" && m.tool_call_id) {
        toolResultMap.set(m.tool_call_id, m);
      }
    }

    // Collect all call IDs from assistant tool_calls
    const allCallIds = new Set<string>();
    for (const m of buf) {
      const tc = (m as any).tool_calls;
      if (m.role === "assistant" && Array.isArray(tc)) {
        for (const c of tc) if (c?.id) allCallIds.add(c.id);
      }
    }

    // --- Pass 1: Classify each assistant+tool_calls ---

    const properlySplitIndices = new Set<number>();      // assistant indices that are properly split
    const properlySplitToolIndices = new Set<number>();   // tool result indices in proper pairs
    const consumedToolCallIds = new Set<string>();        // IDs consumed by flattening

    for (let i = 0; i < buf.length; i++) {
      const msg = buf[i];
      const tc = (msg as any).tool_calls;
      if (msg.role !== "assistant" || !Array.isArray(tc) || tc.length === 0) continue;

      const expectedIds: string[] = tc.map((c: any) => c?.id).filter(Boolean);

      // Check: are ALL matching tool results consecutively after this assistant?
      const followingTools: { id: string; idx: number }[] = [];
      for (let j = i + 1; j < buf.length && buf[j].role === "tool"; j++) {
        if (buf[j].tool_call_id) {
          followingTools.push({ id: buf[j].tool_call_id!, idx: j });
        }
      }

      const followingIds = new Set(followingTools.map(t => t.id));
      const allPresentAndAdjacent =
        expectedIds.length > 0 &&
        expectedIds.every((id: string) => followingIds.has(id)) &&
        followingTools.length >= expectedIds.length;

      if (allPresentAndAdjacent) {
        // Properly split — mark for pass-through
        properlySplitIndices.add(i);
        for (const t of followingTools) {
          if (expectedIds.includes(t.id)) {
            properlySplitToolIndices.add(t.idx);
          }
        }
      } else {
        // Will be flattened — mark all tool_call_ids as consumed
        for (const id of expectedIds) {
          consumedToolCallIds.add(id);
        }
      }
    }

    // --- Pass 2: Build output ---

    const output: ChatMessage[] = [];
    let flattenCount = 0;

    for (let i = 0; i < buf.length; i++) {
      const msg = buf[i];

      // Properly split assistant → pass through as-is
      if (properlySplitIndices.has(i)) {
        output.push(msg);
        continue;
      }

      // Properly split tool result → pass through as-is
      if (properlySplitToolIndices.has(i)) {
        output.push(msg);
        continue;
      }

      const tc = (msg as any).tool_calls;
      if (msg.role === "assistant" && Array.isArray(tc) && tc.length > 0) {
        // Flatten each tool call into a summarized assistant + tool pair
        for (const call of tc) {
          const callId: string = call.id || `flatten_${flattenCount}`;
          const fnName: string = call.function?.name || "unknown_tool";
          const fnArgs: string = call.function?.arguments || "{}";

          // Find matching tool result (may be anywhere in the buffer)
          const toolResult = toolResultMap.get(callId);
          const rawResult = toolResult ? String(toolResult.content ?? "") : "";
          const resultSnippet = rawResult
            ? (rawResult.length > 200 ? rawResult.slice(0, 200) + "..." : rawResult)
            : "[result truncated during compaction]";

          const argsSnippet = fnArgs.length > 100 ? fnArgs.slice(0, 100) + "..." : fnArgs;

          // Summarized assistant message (no tool_calls field!)
          const flatAssistant: ChatMessage = {
            role: "assistant",
            from: msg.from || "VirtualMemory",
            content: `I called ${fnName}(${argsSnippet}) → returned ${resultSnippet}`,
          };
          let parsedArgs: Record<string, unknown> = {};
          try { parsedArgs = JSON.parse(fnArgs); } catch { /* keep empty */ }
          (flatAssistant as any).metadata = {
            summarized_tool_call: {
              id: callId,
              function: fnName,
              args: parsedArgs,
              result: resultSnippet,
            },
          };

          // Matching tool message
          const flatTool: ChatMessage = {
            role: "tool",
            from: fnName,
            content: resultSnippet,
            tool_call_id: callId,
            name: fnName,
          };

          output.push(flatAssistant, flatTool);
          flattenCount++;
        }
        continue;
      }

      // Tool message handling
      if (msg.role === "tool" && msg.tool_call_id) {
        // Consumed by flattening → skip (already represented in the flattened pair)
        if (consumedToolCallIds.has(msg.tool_call_id)) {
          continue;
        }

        // Dangling tool result — no matching assistant tool_calls anywhere
        if (!allCallIds.has(msg.tool_call_id)) {
          Logger.warn(`[VM] flattenCompactedToolCalls: dangling tool result (tool_call_id=${msg.tool_call_id}, name=${msg.name}) — skipping`);
          continue;
        }

        // Belongs to a properly-split pair not yet reached, or other valid state
        output.push(msg);
        continue;
      }

      // All other messages → pass through unchanged
      output.push(msg);
    }

    if (flattenCount > 0) {
      Logger.info(`[VM] flattenCompactedToolCalls: flattened ${flattenCount} tool call(s) into summarized pairs`);
    }

    buf.splice(0, buf.length, ...output);
  }

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
      // Snapshot to phantom buffer before compaction (if enabled)
      if (this.phantomBuffer) {
        const reason = forced ? "manual forceCompact()" : "automatic watermark trigger";
        this.phantomBuffer.snapshot(this.messagesBuffer, reason);
      }

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
      // Collect messages added DURING compaction (not in any lane) so they aren't lost.
      // Messages can be added via memory.add() while summarization API calls are in flight.
      const allLaneMessages = new Set([...sysHead, ...assistant, ...user, ...system, ...tool, ...other]);
      for (const m of this.messagesBuffer) {
        if (keptSet.has(m)) {
          orderedKept.push(m);
        } else if (!allLaneMessages.has(m)) {
          // Message was added after partition() ran — preserve it
          orderedKept.push(m);
        }
      }

      // Insert summaries at the beginning (after system prompt if present)
      const rebuilt: ChatMessage[] = [...summaries, ...orderedKept];
      this.messagesBuffer.splice(0, this.messagesBuffer.length, ...rebuilt);

      // Flatten broken tool call/result pairs into summarized assistant+tool messages.
      // This eliminates tool_calls from compacted messages so OpenAI's strict
      // pairing validation cannot fail regardless of paging fragmentation order.
      this.flattenCompactedToolCalls();

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

  /**
   * Request a page to be loaded into the page slot.
   * Can be called by stream marker handler or explicitly.
   */
  ref(id: string): void {
    if (this.pendingRefs.has(id)) return; // Already pending
    this.pendingRefs.add(id);
    // Track reference frequency for smarter eviction
    const count = (this.pageRefCount.get(id) ?? 0) + 1;
    this.pageRefCount.set(id, count);
    Logger.debug(`[VM] ref('${id}'): frequency now ${count}`);
  }

  /**
   * Request a page to be unloaded from the page slot.
   */
  unref(id: string): void {
    if (this.pinnedPageIds.has(id)) {
      Logger.warn(`[VM] unref('${id}'): page is pinned, ignoring`);
      return;
    }
    this.pendingUnrefs.add(id);
    Logger.debug(`[VM] unref('${id}'): marked for eviction`);
  }

  /**
   * Pin a page to prevent eviction, even if slot is full.
   * Useful for high-value reference materials.
   */
  pinPage(id: string): void {
    if (!this.pages.has(id) && !existsSync(this.pagePath(id))) {
      Logger.warn(`[VM] pinPage('${id}'): page not found`);
      return;
    }
    this.pinnedPageIds.add(id);
    // Ensure it's loaded
    if (!this.activePageIds.has(id)) {
      this.pendingRefs.add(id);
    }
    Logger.info(`[VM] pinPage('${id}'): pinned`);
  }

  /**
   * Unpin a page, making it eligible for LRU/frequency eviction again.
   */
  unpinPage(id: string): void {
    this.pinnedPageIds.delete(id);
    Logger.info(`[VM] unpinPage('${id}'): unpinned`);
  }

  /**
   * Get list of pinned page IDs.
   */
  getPinnedPageIds(): string[] {
    return Array.from(this.pinnedPageIds);
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

  /**
   * Generate a memory performance metrics report.
   * Returns markdown report with lane metrics, recall rates, and tuning recommendations.
   */
  generateMetricsReport(): string | null {
    if (!this.metricsCollector) return null;
    
    // Save current state before generating report
    this.metricsCollector.save();
    
    return this.metricsCollector.generateReport();
  }
}
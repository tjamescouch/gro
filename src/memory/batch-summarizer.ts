/**
 * BatchSummarizer — re-summarize all pages and rebuild the semantic index.
 *
 * Uses a double-buffered index: builds a complete shadow PageSearchIndex
 * while the live index continues serving queries. On completion, performs
 * an atomic swap. This prevents similarity score distortion during the batch.
 *
 * Features:
 * - Content hash skip: pages whose content hasn't changed are not re-summarized
 * - Interruptible with resume: progress tracked in batch-progress.json
 * - Yield-to-interactive: pauses between pages when a conversation turn is pending
 * - Freshness check: pages modified during the batch are caught at swap time
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { Logger } from "../logger.js";
import { PageSearchIndex } from "./page-search-index.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import type { SemanticRetrieval } from "./semantic-retrieval.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BatchSummarizerConfig {
  /** SemanticRetrieval orchestrator (owns the live index) */
  semanticRetrieval: SemanticRetrieval;
  /** Embedding provider for re-embedding summaries */
  embeddingProvider: EmbeddingProvider;
  /** Path to the live embeddings.json */
  indexPath: string;
  /** Directory containing page JSON files (same as VirtualMemory pagesDir) */
  pagesDir: string;
  /** LLM call for generating summaries from page content */
  summarize: (pageContent: string, pageLabel: string) => Promise<string>;
  /** Callback checked before each page — return true to pause the batch */
  shouldYield?: () => boolean;
  /** Async wait called when shouldYield returns true */
  waitForIdle?: () => Promise<void>;
}

export interface BatchResult {
  total: number;
  summarized: number;
  skipped: number;
  failed: number;
  resumed: boolean;
  durationMs: number;
}

interface SummaryManifest {
  version: number;
  hashes: Record<string, string>;  // pageId → SHA-256 of first 4KB of content
  updatedAt: string;
}

interface BatchProgress {
  version: number;
  startedAt: string;
  completedPageIds: string[];
  failedPageIds: string[];
  shadowIndexPath: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contentHash(content: string): string {
  return createHash("sha256").update(content.slice(0, 4096)).digest("hex");
}

function loadManifest(path: string): SummaryManifest {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SummaryManifest;
  } catch {
    return { version: 1, hashes: {}, updatedAt: "" };
  }
}

function saveManifest(path: string, manifest: SummaryManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}

function loadProgress(path: string): BatchProgress | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as BatchProgress;
  } catch {
    return null;
  }
}

function saveProgress(path: string, progress: BatchProgress): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(progress, null, 2) + "\n");
}

interface PageFile {
  id: string;
  label: string;
  content: string;
  summary?: string;
}

function loadPageFile(pagesDir: string, pageId: string): PageFile | null {
  try {
    const filePath = join(pagesDir, `${pageId}.json`);
    return JSON.parse(readFileSync(filePath, "utf-8")) as PageFile;
  } catch {
    return null;
  }
}

function pageFileMtime(pagesDir: string, pageId: string): number {
  try {
    return statSync(join(pagesDir, `${pageId}.json`)).mtimeMs;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// BatchSummarizer
// ---------------------------------------------------------------------------

export class BatchSummarizer {
  private config: BatchSummarizerConfig;
  private manifestPath: string;
  private progressPath: string;
  private shadowPath: string;
  private cancelled = false;

  constructor(config: BatchSummarizerConfig) {
    this.config = config;
    this.manifestPath = join(config.pagesDir, "summary-manifest.json");
    this.progressPath = join(config.pagesDir, "batch-progress.json");
    this.shadowPath = join(dirname(config.indexPath), "embeddings.shadow.json");
  }

  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Run a full batch re-summarization.
   * @param options.force — re-summarize all pages regardless of content hash
   */
  async run(options?: { force?: boolean }): Promise<BatchResult> {
    return this._execute(false, options?.force ?? false);
  }

  /** Resume an interrupted batch from batch-progress.json. */
  async resume(): Promise<BatchResult> {
    const progress = loadProgress(this.progressPath);
    if (!progress) {
      Logger.telemetry("[BatchSummarizer] No interrupted batch to resume, starting fresh");
      return this._execute(false, false);
    }
    return this._execute(true, false);
  }

  private async _execute(isResume: boolean, force: boolean): Promise<BatchResult> {
    const startTime = Date.now();
    const { semanticRetrieval, embeddingProvider, indexPath, pagesDir, summarize } = this.config;

    // Mutex check
    if (semanticRetrieval.batchRunning) {
      Logger.warn("[BatchSummarizer] Another batch is already running");
      return { total: 0, summarized: 0, skipped: 0, failed: 0, resumed: isResume, durationMs: 0 };
    }
    semanticRetrieval.batchRunning = true;
    this.cancelled = false;

    try {
      const manifest = loadManifest(this.manifestPath);
      const batchStartedAt = isResume
        ? (loadProgress(this.progressPath)?.startedAt ?? new Date().toISOString())
        : new Date().toISOString();
      const batchStartMs = new Date(batchStartedAt).getTime();

      // Load or create progress
      let progress: BatchProgress;
      if (isResume) {
        progress = loadProgress(this.progressPath) ?? {
          version: 1,
          startedAt: batchStartedAt,
          completedPageIds: [],
          failedPageIds: [],
          shadowIndexPath: this.shadowPath,
        };
      } else {
        progress = {
          version: 1,
          startedAt: batchStartedAt,
          completedPageIds: [],
          failedPageIds: [],
          shadowIndexPath: this.shadowPath,
        };
      }

      // Build shadow index from scratch
      const shadowIndex = PageSearchIndex.fromScratch({
        indexPath: this.shadowPath,
        embeddingProvider,
      });

      // If resuming, load the shadow index built so far
      if (isResume && existsSync(this.shadowPath)) {
        await shadowIndex.load();
      }

      // Discover all page files
      const allPageIds = this.discoverPageIds(pagesDir);
      const completedSet = new Set(progress.completedPageIds);
      const failedSet = new Set(progress.failedPageIds);

      // Track mtime after our own writes so freshness check ignores batch's own modifications
      const writtenMtimes: Map<string, number> = new Map();

      let summarized = 0;
      let skipped = 0;
      let failed = 0;

      for (const pageId of allPageIds) {
        if (this.cancelled) {
          Logger.telemetry("[BatchSummarizer] Cancelled — saving progress");
          break;
        }

        // Skip already-completed pages (resume support)
        if (completedSet.has(pageId)) {
          skipped++;
          continue;
        }

        // Yield to interactive session if needed
        if (this.config.shouldYield?.()) {
          Logger.telemetry("[BatchSummarizer] Yielding to interactive session");
          saveProgress(this.progressPath, progress);
          shadowIndex.save(this.shadowPath);
          if (this.config.waitForIdle) {
            await this.config.waitForIdle();
          }
        }

        // Load page content
        const page = loadPageFile(pagesDir, pageId);
        if (!page) {
          failed++;
          failedSet.add(pageId);
          progress.failedPageIds.push(pageId);
          continue;
        }

        // Content hash skip: if content hasn't changed, reuse existing summary
        const hash = contentHash(page.content);
        if (!force && manifest.hashes[pageId] === hash && page.summary) {
          // Content unchanged — just re-embed the existing summary into shadow
          try {
            await shadowIndex.indexPage(pageId, page.summary, page.label);
            completedSet.add(pageId);
            progress.completedPageIds.push(pageId);
            skipped++;
          } catch (err) {
            Logger.warn(`[BatchSummarizer] Re-embed failed for ${pageId}: ${err}`);
            failed++;
            failedSet.add(pageId);
            progress.failedPageIds.push(pageId);
          }
          continue;
        }

        // Re-summarize
        try {
          const newSummary = await summarize(page.content, page.label);

          // Update the page file with new summary
          page.summary = newSummary;
          const pageFilePath = join(pagesDir, `${pageId}.json`);
          writeFileSync(pageFilePath, JSON.stringify(page, null, 2) + "\n");
          writtenMtimes.set(pageId, pageFileMtime(pagesDir, pageId));

          // Embed into shadow index
          await shadowIndex.indexPage(pageId, newSummary, page.label);

          // Update manifest hash
          manifest.hashes[pageId] = hash;

          completedSet.add(pageId);
          progress.completedPageIds.push(pageId);
          summarized++;

          // Periodic save (every 10 pages)
          if (summarized % 10 === 0) {
            saveProgress(this.progressPath, progress);
            shadowIndex.save(this.shadowPath);
          }
        } catch (err) {
          Logger.warn(`[BatchSummarizer] Failed to summarize ${pageId}: ${err}`);
          failed++;
          failedSet.add(pageId);
          progress.failedPageIds.push(pageId);
        }
      }

      if (this.cancelled) {
        saveProgress(this.progressPath, progress);
        shadowIndex.save(this.shadowPath);
        return {
          total: allPageIds.length,
          summarized, skipped, failed,
          resumed: isResume,
          durationMs: Date.now() - startTime,
        };
      }

      // --- Freshness check ---
      // Pages modified externally during the batch need re-summarization before swap.
      // Compare current mtime against the mtime recorded after our own writes.
      const freshPages = allPageIds.filter(id => {
        if (!completedSet.has(id)) return false;
        const currentMtime = pageFileMtime(pagesDir, id);
        const ourMtime = writtenMtimes.get(id);
        // If we wrote this page, only flag if mtime changed since our write (external modification)
        if (ourMtime !== undefined) return currentMtime > ourMtime;
        // For hash-skipped pages (no write), flag if modified after batch start
        return currentMtime > batchStartMs;
      });

      if (freshPages.length > 0) {
        Logger.telemetry(`[BatchSummarizer] Freshness check: ${freshPages.length} pages modified during batch`);
        for (const pageId of freshPages) {
          const page = loadPageFile(pagesDir, pageId);
          if (!page) continue;
          try {
            const newSummary = await summarize(page.content, page.label);
            page.summary = newSummary;
            writeFileSync(join(pagesDir, `${pageId}.json`), JSON.stringify(page, null, 2) + "\n");
            await shadowIndex.indexPage(pageId, newSummary, page.label);
            manifest.hashes[pageId] = contentHash(page.content);
          } catch (err) {
            Logger.warn(`[BatchSummarizer] Freshness re-summarize failed for ${pageId}: ${err}`);
          }
        }
      }

      // --- Atomic swap ---
      // 1. Write shadow to disk
      shadowIndex.save(this.shadowPath);

      // 2. Swap the live index reference (synchronous — no queries slip through)
      shadowIndex.setIndexPath(indexPath);
      semanticRetrieval.swapIndex(shadowIndex);

      // 3. Atomic rename shadow → live (POSIX atomic)
      try {
        renameSync(this.shadowPath, indexPath);
      } catch {
        // Fallback: write directly if rename fails (cross-device)
        shadowIndex.save(indexPath);
        try { unlinkSync(this.shadowPath); } catch { /* noop */ }
      }

      // 4. Clean up progress file
      try { unlinkSync(this.progressPath); } catch { /* noop */ }

      // 5. Update manifest
      manifest.updatedAt = new Date().toISOString();
      saveManifest(this.manifestPath, manifest);

      Logger.telemetry(
        `[BatchSummarizer] Complete: ${summarized} summarized, ${skipped} skipped, ${failed} failed (${Date.now() - startTime}ms)`
      );

      return {
        total: allPageIds.length,
        summarized, skipped, failed,
        resumed: isResume,
        durationMs: Date.now() - startTime,
      };
    } finally {
      semanticRetrieval.batchRunning = false;
    }
  }

  /** Discover all page IDs from the pages directory. */
  private discoverPageIds(pagesDir: string): string[] {
    try {
      return readdirSync(pagesDir)
        .filter((f: string) => f.startsWith("pg_") && f.endsWith(".json"))
        .map((f: string) => f.replace(".json", ""));
    } catch {
      return [];
    }
  }

  /**
   * Detect and recover from an orphaned shadow index (process crashed mid-swap).
   * Call on startup before normal operations.
   */
  static recoverOrphanedShadow(indexPath: string, shadowPath: string): boolean {
    if (!existsSync(shadowPath)) return false;

    // If shadow exists but progress doesn't, the swap was interrupted after step 1
    const progressPath = join(dirname(indexPath), "batch-progress.json");
    if (!existsSync(progressPath)) {
      Logger.telemetry("[BatchSummarizer] Recovering orphaned shadow index");
      try {
        renameSync(shadowPath, indexPath);
        return true;
      } catch {
        try { unlinkSync(shadowPath); } catch { /* noop */ }
        return false;
      }
    }

    return false;
  }
}

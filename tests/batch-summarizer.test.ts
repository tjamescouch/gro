import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync, rmSync, existsSync, readFileSync, writeFileSync,
  unlinkSync, utimesSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import type { EmbeddingProvider } from "../src/memory/embedding-provider.js";
import { PageSearchIndex } from "../src/memory/page-search-index.js";
import { SemanticRetrieval } from "../src/memory/semantic-retrieval.js";
import { BatchSummarizer, type BatchResult } from "../src/memory/batch-summarizer.js";

// ---------------------------------------------------------------------------
// Mock embedding provider
// ---------------------------------------------------------------------------

function mockEmbeddingProvider(dim = 8): EmbeddingProvider {
  function embed(text: string): number[] {
    const vec = new Array(dim).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % dim] += text.charCodeAt(i) / 1000;
    }
    const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
    return norm === 0 ? vec : vec.map((v: number) => v / norm);
  }

  return {
    embed: async (texts: string[]) => texts.map(embed),
    dimension: dim,
    model: "mock-embed-v1",
    provider: "mock",
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  const dir = join(tmpdir(), `gro-batch-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mockMemory() {
  const refs: string[] = [];
  const activeIds = new Set<string>();
  const pages: Array<{ id: string; label: string; summary?: string }> = [];

  return {
    ref(id: string) { refs.push(id); activeIds.add(id); },
    getActivePageIds() { return Array.from(activeIds); },
    getPages() { return pages; },
    _refs: refs,
    _activeIds: activeIds,
    _pages: pages,
    addPage(id: string, label: string, summary?: string) {
      pages.push({ id, label, summary });
    },
  };
}

/** Create a page JSON file on disk in the pages directory. */
function writePage(pagesDir: string, pageId: string, content: string, label: string, summary?: string): void {
  const page = { id: pageId, label, content, summary };
  writeFileSync(join(pagesDir, `${pageId}.json`), JSON.stringify(page, null, 2) + "\n");
}

/** Build a BatchSummarizer with standard test config. */
function makeBatch(
  pagesDir: string,
  indexPath: string,
  provider: EmbeddingProvider,
  retrieval: SemanticRetrieval,
  options?: {
    summarize?: (content: string, label: string) => Promise<string>;
    shouldYield?: () => boolean;
    waitForIdle?: () => Promise<void>;
  },
): BatchSummarizer {
  return new BatchSummarizer({
    semanticRetrieval: retrieval,
    embeddingProvider: provider,
    indexPath,
    pagesDir,
    summarize: options?.summarize ?? (async (_content, label) => `Summary of ${label}`),
    shouldYield: options?.shouldYield,
    waitForIdle: options?.waitForIdle,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BatchSummarizer", () => {
  it("skip unchanged pages (content hash match)", async () => {
    const dir = tmpDir();
    const pagesDir = join(dir, "pages");
    mkdirSync(pagesDir, { recursive: true });
    const indexPath = join(dir, "embeddings.json");
    const provider = mockEmbeddingProvider();
    const searchIndex = new PageSearchIndex({ indexPath, embeddingProvider: provider });
    const mem = mockMemory();
    const retrieval = new SemanticRetrieval({ memory: mem, searchIndex });

    // Create 3 pages
    writePage(pagesDir, "pg_001", "Content about JavaScript", "js", "Old summary 1");
    writePage(pagesDir, "pg_002", "Content about Python", "python", "Old summary 2");
    writePage(pagesDir, "pg_003", "Content about Rust", "rust", "Old summary 3");

    let summarizeCalls = 0;
    const summarize = async (_content: string, label: string) => {
      summarizeCalls++;
      return `New summary of ${label}`;
    };

    const batch = makeBatch(pagesDir, indexPath, provider, retrieval, { summarize });

    // First run — all pages should be summarized (no manifest yet)
    const result1 = await batch.run();
    assert.equal(result1.summarized, 3, "first run should summarize all 3 pages");
    assert.equal(summarizeCalls, 3, "should call summarize 3 times");

    // Small delay to ensure mtime differences
    await new Promise(r => setTimeout(r, 50));

    // Second run — no content changed, all should be skipped
    summarizeCalls = 0;
    const batch2 = makeBatch(pagesDir, indexPath, provider, retrieval, { summarize });
    const result2 = await batch2.run();
    assert.equal(result2.summarized, 0, `second run should summarize 0 pages, got summarized=${result2.summarized}, skipped=${result2.skipped}, failed=${result2.failed}`);
    assert.equal(result2.skipped, 3, "all 3 pages should be skipped");
    assert.equal(summarizeCalls, 0, "should not call summarize on unchanged content");

    // Modify one page's content
    writePage(pagesDir, "pg_002", "Updated content about Python ML", "python", "Old summary 2");
    summarizeCalls = 0;
    const batch3 = makeBatch(pagesDir, indexPath, provider, retrieval, { summarize });
    const result3 = await batch3.run();
    assert.equal(result3.summarized, 1, "third run should summarize only changed page");
    assert.equal(result3.skipped, 2, "two unchanged pages should be skipped");

    rmSync(dir, { recursive: true, force: true });
  });

  it("shadow index isolation (live index not mutated during batch)", async () => {
    const dir = tmpDir();
    const pagesDir = join(dir, "pages");
    mkdirSync(pagesDir, { recursive: true });
    const indexPath = join(dir, "embeddings.json");
    const provider = mockEmbeddingProvider();
    const searchIndex = new PageSearchIndex({ indexPath, embeddingProvider: provider });
    const mem = mockMemory();
    const retrieval = new SemanticRetrieval({ memory: mem, searchIndex });

    // Pre-index one page in the live index
    await searchIndex.indexPage("pg_existing", "Existing content", "existing");
    const liveSizeBefore = searchIndex.size;

    // Create pages on disk
    writePage(pagesDir, "pg_001", "Content A", "page A");
    writePage(pagesDir, "pg_002", "Content B", "page B");

    const batch = makeBatch(pagesDir, indexPath, provider, retrieval);
    const result = await batch.run();

    assert.equal(result.total, 2, "should find 2 pages");
    assert.equal(result.summarized, 2, "should summarize 2 pages");

    // After the atomic swap, the live index should now have exactly the
    // pages from the shadow (the batch rebuilds from scratch)
    // The old "pg_existing" entry won't be in the new index because
    // it's not on disk as pg_existing.json
    const newSize = retrieval.getSearchIndex().size;
    assert.equal(newSize, 2, "after swap, index should have the 2 batch pages");

    rmSync(dir, { recursive: true, force: true });
  });

  it("atomic swap updates live index", async () => {
    const dir = tmpDir();
    const pagesDir = join(dir, "pages");
    mkdirSync(pagesDir, { recursive: true });
    const indexPath = join(dir, "embeddings.json");
    const provider = mockEmbeddingProvider();
    const searchIndex = new PageSearchIndex({ indexPath, embeddingProvider: provider });
    const mem = mockMemory();
    const retrieval = new SemanticRetrieval({ memory: mem, searchIndex });

    // Start with empty index
    assert.equal(searchIndex.size, 0, "live index starts empty");

    // Create 2 pages
    writePage(pagesDir, "pg_001", "JavaScript content", "js");
    writePage(pagesDir, "pg_002", "Python content", "python");

    const batch = makeBatch(pagesDir, indexPath, provider, retrieval);
    await batch.run();

    // After batch, the live index (accessed via retrieval) should be updated
    const currentIndex = retrieval.getSearchIndex();
    assert.equal(currentIndex.size, 2, "live index should have 2 entries after swap");

    // The embeddings.json file should exist on disk
    assert.ok(existsSync(indexPath), "embeddings.json should exist");

    // The shadow file should be cleaned up
    const shadowPath = join(dir, "embeddings.shadow.json");
    assert.ok(!existsSync(shadowPath), "shadow file should be cleaned up");

    rmSync(dir, { recursive: true, force: true });
  });

  it("resume from interrupted batch", async () => {
    const dir = tmpDir();
    const pagesDir = join(dir, "pages");
    mkdirSync(pagesDir, { recursive: true });
    const indexPath = join(dir, "embeddings.json");
    const provider = mockEmbeddingProvider();
    const searchIndex = new PageSearchIndex({ indexPath, embeddingProvider: provider });
    const mem = mockMemory();
    const retrieval = new SemanticRetrieval({ memory: mem, searchIndex });

    // Create 5 pages
    for (let i = 1; i <= 5; i++) {
      writePage(pagesDir, `pg_00${i}`, `Content ${i}`, `page ${i}`);
    }

    // Start batch, cancel after 2 pages
    let summarizeCount = 0;
    const batch1 = new BatchSummarizer({
      semanticRetrieval: retrieval,
      embeddingProvider: provider,
      indexPath,
      pagesDir,
      summarize: async (_content, label) => {
        summarizeCount++;
        if (summarizeCount >= 2) {
          batch1.cancel();
        }
        return `Summary of ${label}`;
      },
    });

    const result1 = await batch1.run();
    assert.ok(result1.summarized >= 2, "should have summarized at least 2 pages before cancel");
    assert.ok(result1.summarized < 5, "should not have summarized all 5 pages");

    // Progress file should exist
    const progressPath = join(pagesDir, "batch-progress.json");
    assert.ok(existsSync(progressPath), "batch-progress.json should exist after cancel");

    // Resume the batch
    summarizeCount = 0;
    const batch2 = new BatchSummarizer({
      semanticRetrieval: retrieval,
      embeddingProvider: provider,
      indexPath,
      pagesDir,
      summarize: async (_content, label) => {
        summarizeCount++;
        return `Summary of ${label}`;
      },
    });

    const result2 = await batch2.resume();
    assert.ok(result2.resumed, "should indicate this is a resume");
    // Previously completed pages should be skipped
    assert.ok(result2.skipped > 0, "should skip previously completed pages");

    // After resume completes, progress file should be cleaned up
    assert.ok(!existsSync(progressPath), "batch-progress.json should be cleaned up");

    rmSync(dir, { recursive: true, force: true });
  });

  it("freshness check re-summarizes pages modified during batch", async () => {
    const dir = tmpDir();
    const pagesDir = join(dir, "pages");
    mkdirSync(pagesDir, { recursive: true });
    const indexPath = join(dir, "embeddings.json");
    const provider = mockEmbeddingProvider();
    const searchIndex = new PageSearchIndex({ indexPath, embeddingProvider: provider });
    const mem = mockMemory();
    const retrieval = new SemanticRetrieval({ memory: mem, searchIndex });

    // Create 3 pages
    writePage(pagesDir, "pg_001", "Content A", "page A");
    writePage(pagesDir, "pg_002", "Content B", "page B");
    writePage(pagesDir, "pg_003", "Content C", "page C");

    let summarizeCalls: string[] = [];
    let pagesProcessed = 0;
    const batch = new BatchSummarizer({
      semanticRetrieval: retrieval,
      embeddingProvider: provider,
      indexPath,
      pagesDir,
      summarize: async (content, label) => {
        summarizeCalls.push(label);
        pagesProcessed++;
        // After pg_001 has been fully processed by the batch (including its own write),
        // simulate an external modification to pg_001 by writing with a future timestamp.
        // We do this when processing the LAST page (pg_003) so pg_001 has already been
        // written by the batch and has a recorded mtime.
        if (pagesProcessed === 3) {
          // External modification — changes content and sets mtime far in future
          writePage(pagesDir, "pg_001", "Externally modified content A", "page A", "external summary");
          const future = new Date(Date.now() + 10000);
          utimesSync(join(pagesDir, "pg_001.json"), future, future);
        }
        return `Summary of ${label}`;
      },
    });

    const result = await batch.run();
    assert.equal(result.total, 3, "should find 3 pages");

    // pg_001 should appear in summarize calls at least twice:
    // once during normal batch + once during freshness check (external mod detected)
    const pg001Calls = summarizeCalls.filter(l => l === "page A");
    assert.ok(pg001Calls.length >= 2, `pg_001 should be summarized at least twice (freshness), got ${pg001Calls.length}`);

    rmSync(dir, { recursive: true, force: true });
  });

  it("yield-to-interactive pauses batch", async () => {
    const dir = tmpDir();
    const pagesDir = join(dir, "pages");
    mkdirSync(pagesDir, { recursive: true });
    const indexPath = join(dir, "embeddings.json");
    const provider = mockEmbeddingProvider();
    const searchIndex = new PageSearchIndex({ indexPath, embeddingProvider: provider });
    const mem = mockMemory();
    const retrieval = new SemanticRetrieval({ memory: mem, searchIndex });

    // Create 3 pages
    writePage(pagesDir, "pg_001", "Content A", "page A");
    writePage(pagesDir, "pg_002", "Content B", "page B");
    writePage(pagesDir, "pg_003", "Content C", "page C");

    let yieldCount = 0;
    let shouldYieldFlag = false;
    let waitForIdleCalls = 0;

    const batch = makeBatch(pagesDir, indexPath, provider, retrieval, {
      shouldYield: () => {
        // Yield after first page processed
        if (yieldCount === 0) {
          yieldCount++;
          shouldYieldFlag = true;
          return true;
        }
        shouldYieldFlag = false;
        return false;
      },
      waitForIdle: async () => {
        waitForIdleCalls++;
        // Simulate idle — just resolve immediately
      },
    });

    const result = await batch.run();
    assert.equal(result.total, 3, "should find 3 pages");
    assert.ok(waitForIdleCalls >= 1, `waitForIdle should have been called at least once, got ${waitForIdleCalls}`);

    rmSync(dir, { recursive: true, force: true });
  });

  it("mutex guard prevents concurrent batches", async () => {
    const dir = tmpDir();
    const pagesDir = join(dir, "pages");
    mkdirSync(pagesDir, { recursive: true });
    const indexPath = join(dir, "embeddings.json");
    const provider = mockEmbeddingProvider();
    const searchIndex = new PageSearchIndex({ indexPath, embeddingProvider: provider });
    const mem = mockMemory();
    const retrieval = new SemanticRetrieval({ memory: mem, searchIndex });

    // Create a page
    writePage(pagesDir, "pg_001", "Content A", "page A");

    // Simulate batchRunning = true
    retrieval.batchRunning = true;

    const batch = makeBatch(pagesDir, indexPath, provider, retrieval);
    const result = await batch.run();

    // Should be a no-op
    assert.equal(result.total, 0, "should not process any pages");
    assert.equal(result.summarized, 0, "should not summarize any pages");

    // Clean up
    retrieval.batchRunning = false;

    rmSync(dir, { recursive: true, force: true });
  });

  it("orphaned shadow recovery", () => {
    const dir = tmpDir();
    const indexPath = join(dir, "embeddings.json");
    const shadowPath = join(dir, "embeddings.shadow.json");

    // Create an orphaned shadow (no progress file = swap was interrupted)
    writeFileSync(shadowPath, JSON.stringify({ version: 1, entries: {} }) + "\n");

    const recovered = BatchSummarizer.recoverOrphanedShadow(indexPath, shadowPath);
    assert.ok(recovered, "should detect and recover orphaned shadow");
    assert.ok(existsSync(indexPath), "shadow should be renamed to live path");
    assert.ok(!existsSync(shadowPath), "shadow file should be removed");

    rmSync(dir, { recursive: true, force: true });
  });

  it("force flag re-summarizes all pages", async () => {
    const dir = tmpDir();
    const pagesDir = join(dir, "pages");
    mkdirSync(pagesDir, { recursive: true });
    const indexPath = join(dir, "embeddings.json");
    const provider = mockEmbeddingProvider();
    const searchIndex = new PageSearchIndex({ indexPath, embeddingProvider: provider });
    const mem = mockMemory();
    const retrieval = new SemanticRetrieval({ memory: mem, searchIndex });

    // Create 2 pages
    writePage(pagesDir, "pg_001", "Content A", "page A");
    writePage(pagesDir, "pg_002", "Content B", "page B");

    let summarizeCalls = 0;
    const summarize = async (_content: string, label: string) => {
      summarizeCalls++;
      return `Summary of ${label}`;
    };

    // First run
    const batch1 = makeBatch(pagesDir, indexPath, provider, retrieval, { summarize });
    await batch1.run();
    assert.equal(summarizeCalls, 2, "first run should summarize all pages");

    // Second run without force — should skip
    summarizeCalls = 0;
    const batch2 = makeBatch(pagesDir, indexPath, provider, retrieval, { summarize });
    const result2 = await batch2.run();
    assert.equal(result2.summarized, 0, "should skip all without force");

    // Third run WITH force — should re-summarize all
    summarizeCalls = 0;
    const batch3 = makeBatch(pagesDir, indexPath, provider, retrieval, { summarize });
    const result3 = await batch3.run({ force: true });
    assert.equal(result3.summarized, 2, "force should re-summarize all pages");
    assert.equal(summarizeCalls, 2, "should call summarize on all pages with force");

    rmSync(dir, { recursive: true, force: true });
  });
});

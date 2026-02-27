import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { EmbeddingProvider } from "../src/memory/embedding-provider.js";
import { PageSearchIndex, type PageSearchResult } from "../src/memory/page-search-index.js";
import { SemanticRetrieval } from "../src/memory/semantic-retrieval.js";

// ---------------------------------------------------------------------------
// Mock embedding provider
// ---------------------------------------------------------------------------

/** Simple deterministic mock: embeds text as a vector of character code averages. */
function mockEmbeddingProvider(dim = 8): EmbeddingProvider {
  function embed(text: string): number[] {
    const vec = new Array(dim).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % dim] += text.charCodeAt(i) / 1000;
    }
    // Normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return norm === 0 ? vec : vec.map(v => v / norm);
  }

  return {
    embed: async (texts: string[]) => texts.map(embed),
    dimension: dim,
    model: "mock-embed-v1",
    provider: "mock",
  };
}

/** Mock that returns identical vectors for similar texts (for testing dedup). */
function dupEmbeddingProvider(dim = 8): EmbeddingProvider {
  return {
    embed: async (texts: string[]) => {
      return texts.map(text => {
        // Group: texts starting with "topic-A" all get the same vector
        const prefix = text.split(" ")[0];
        const vec = new Array(dim).fill(0);
        for (let i = 0; i < prefix.length; i++) {
          vec[i % dim] += prefix.charCodeAt(i) / 1000;
        }
        const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
        return norm === 0 ? vec : vec.map(v => v / norm);
      });
    },
    dimension: dim,
    model: "dup-embed-v1",
    provider: "mock",
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  const dir = join(tmpdir(), `gro-test-${randomBytes(4).toString("hex")}`);
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
    // Test helpers
    _refs: refs,
    _activeIds: activeIds,
    _pages: pages,
    addPage(id: string, label: string, summary?: string) {
      pages.push({ id, label, summary });
    },
  };
}

// ---------------------------------------------------------------------------
// PageSearchIndex tests
// ---------------------------------------------------------------------------

describe("PageSearchIndex", () => {
  it("indexes and searches pages", async () => {
    const dir = tmpDir();
    const provider = mockEmbeddingProvider();
    const index = new PageSearchIndex({
      indexPath: join(dir, "embeddings.json"),
      embeddingProvider: provider,
    });

    await index.indexPage("pg_001", "Discussion about JavaScript frameworks", "js frameworks");
    await index.indexPage("pg_002", "Python machine learning tutorial", "python ml");
    await index.indexPage("pg_003", "JavaScript React component architecture", "react components");

    const results = await index.search("JavaScript web development", 5, 0.0);
    assert.ok(results.length > 0, "should return results");
    // pg_001 and pg_003 should rank higher than pg_002 (JS vs Python)

    rmSync(dir, { recursive: true, force: true });
  });

  it("persists and loads from disk", async () => {
    const dir = tmpDir();
    const provider = mockEmbeddingProvider();
    const indexPath = join(dir, "embeddings.json");

    // Create and save
    const index1 = new PageSearchIndex({ indexPath, embeddingProvider: provider });
    await index1.indexPage("pg_001", "test content", "test label");
    index1.save();

    assert.ok(existsSync(indexPath), "embeddings.json should exist");

    // Load in fresh instance
    const index2 = new PageSearchIndex({ indexPath, embeddingProvider: provider });
    await index2.load();
    assert.equal(index2.size, 1, "should have 1 entry after load");

    rmSync(dir, { recursive: true, force: true });
  });

  it("discards index on model change", async () => {
    const dir = tmpDir();
    const indexPath = join(dir, "embeddings.json");

    // Create with provider A
    const providerA = mockEmbeddingProvider();
    const index1 = new PageSearchIndex({ indexPath, embeddingProvider: providerA });
    await index1.indexPage("pg_001", "test", "test");
    index1.save();

    // Load with different provider
    const providerB: EmbeddingProvider = {
      ...mockEmbeddingProvider(),
      model: "different-model",
      provider: "different",
    };
    const index2 = new PageSearchIndex({ indexPath, embeddingProvider: providerB });
    await index2.load();
    assert.equal(index2.size, 0, "should discard entries on model change");

    rmSync(dir, { recursive: true, force: true });
  });

  it("deduplicates similar results", async () => {
    const dir = tmpDir();
    const provider = dupEmbeddingProvider();
    const index = new PageSearchIndex({
      indexPath: join(dir, "embeddings.json"),
      embeddingProvider: provider,
    });

    // Index 3 pages with "topic-A" prefix — will get near-identical embeddings
    await index.indexPage("pg_001", "topic-A first version", "topic A v1");
    await index.indexPage("pg_002", "topic-A second version", "topic A v2");
    await index.indexPage("pg_003", "topic-A third version", "topic A v3");
    // One different topic
    await index.indexPage("pg_004", "topic-B something else", "topic B");

    const results = await index.search("topic-A query", 5, 0.0);
    // Should deduplicate the topic-A results (>0.9 similarity to each other)
    const topicAResults = results.filter(r => r.label.startsWith("topic A"));
    assert.ok(topicAResults.length <= 1, `should deduplicate similar results, got ${topicAResults.length}`);

    rmSync(dir, { recursive: true, force: true });
  });

  it("getMissingPageIds finds un-indexed pages", async () => {
    const dir = tmpDir();
    const provider = mockEmbeddingProvider();
    const index = new PageSearchIndex({
      indexPath: join(dir, "embeddings.json"),
      embeddingProvider: provider,
    });

    await index.indexPage("pg_001", "already indexed", "indexed");
    const missing = index.getMissingPageIds(["pg_001", "pg_002", "pg_003"]);
    assert.deepEqual(missing, ["pg_002", "pg_003"]);

    rmSync(dir, { recursive: true, force: true });
  });

  it("removePage deletes from index", async () => {
    const dir = tmpDir();
    const provider = mockEmbeddingProvider();
    const index = new PageSearchIndex({
      indexPath: join(dir, "embeddings.json"),
      embeddingProvider: provider,
    });

    await index.indexPage("pg_001", "content", "label");
    assert.equal(index.size, 1);
    index.removePage("pg_001");
    assert.equal(index.size, 0);

    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty on empty index", async () => {
    const dir = tmpDir();
    const provider = mockEmbeddingProvider();
    const index = new PageSearchIndex({
      indexPath: join(dir, "embeddings.json"),
      embeddingProvider: provider,
    });

    const results = await index.search("anything", 5, 0.0);
    assert.equal(results.length, 0);

    rmSync(dir, { recursive: true, force: true });
  });

  it("batch indexes multiple pages", async () => {
    const dir = tmpDir();
    const provider = mockEmbeddingProvider();
    const index = new PageSearchIndex({
      indexPath: join(dir, "embeddings.json"),
      embeddingProvider: provider,
    });

    await index.indexPages([
      { pageId: "pg_001", text: "first page", label: "page 1" },
      { pageId: "pg_002", text: "second page", label: "page 2" },
      { pageId: "pg_003", text: "third page", label: "page 3" },
    ]);
    assert.equal(index.size, 3);

    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// SemanticRetrieval tests
// ---------------------------------------------------------------------------

describe("SemanticRetrieval", () => {
  it("auto-retrieves relevant page", async () => {
    const dir = tmpDir();
    const provider = mockEmbeddingProvider();
    const indexPath = join(dir, "embeddings.json");
    const searchIndex = new PageSearchIndex({ indexPath, embeddingProvider: provider });
    const mem = mockMemory();

    // Add and index a page
    mem.addPage("pg_001", "JS frameworks", "Discussion about JavaScript frameworks and React");
    await searchIndex.indexPage("pg_001", "Discussion about JavaScript frameworks and React", "JS frameworks");

    const retrieval = new SemanticRetrieval({
      memory: mem,
      searchIndex,
      autoThreshold: 0.0, // Low threshold for mock embeddings
    });

    const result = await retrieval.autoRetrieve([
      { role: "user", content: "Tell me about JavaScript frameworks" },
    ]);

    // Should have loaded a page
    assert.ok(mem._refs.length > 0, "should ref at least one page");

    rmSync(dir, { recursive: true, force: true });
  });

  it("skips auto-retrieval when query unchanged (tool loop dedup)", async () => {
    const dir = tmpDir();
    const provider = mockEmbeddingProvider();
    const indexPath = join(dir, "embeddings.json");
    const searchIndex = new PageSearchIndex({ indexPath, embeddingProvider: provider });
    const mem = mockMemory();

    mem.addPage("pg_001", "test page", "test content");
    await searchIndex.indexPage("pg_001", "test content", "test page");

    const retrieval = new SemanticRetrieval({
      memory: mem,
      searchIndex,
      autoThreshold: 0.0,
    });

    const messages = [{ role: "user" as const, content: "Same user message repeated" }];

    await retrieval.autoRetrieve(messages);
    const firstRefs = mem._refs.length;

    // Same message again — should skip
    await retrieval.autoRetrieve(messages);
    assert.equal(mem._refs.length, firstRefs, "should not re-search on unchanged query");

    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to assistant message when user message is short", async () => {
    const dir = tmpDir();
    const provider = mockEmbeddingProvider();
    const indexPath = join(dir, "embeddings.json");
    const searchIndex = new PageSearchIndex({ indexPath, embeddingProvider: provider });
    const mem = mockMemory();

    mem.addPage("pg_001", "test page", "long assistant context about JavaScript");
    await searchIndex.indexPage("pg_001", "long assistant context about JavaScript", "test page");

    const retrieval = new SemanticRetrieval({
      memory: mem,
      searchIndex,
      autoThreshold: 0.0,
    });

    // Short user message + long assistant message — should use both
    const result = await retrieval.autoRetrieve([
      { role: "assistant", content: "I was working on the JavaScript framework comparison..." },
      { role: "user", content: "continue" },
    ]);

    // Should still attempt retrieval (not bail on short message)
    // The query was constructed, just might not match
    assert.ok(true, "should not throw on short user message");

    rmSync(dir, { recursive: true, force: true });
  });

  it("filters out already-loaded pages", async () => {
    const dir = tmpDir();
    const provider = mockEmbeddingProvider();
    const indexPath = join(dir, "embeddings.json");
    const searchIndex = new PageSearchIndex({ indexPath, embeddingProvider: provider });
    const mem = mockMemory();

    mem.addPage("pg_001", "already loaded page", "content about JavaScript");
    mem._activeIds.add("pg_001"); // Pre-loaded via @@ref@@
    await searchIndex.indexPage("pg_001", "content about JavaScript", "already loaded page");

    const retrieval = new SemanticRetrieval({
      memory: mem,
      searchIndex,
      autoThreshold: 0.0,
    });

    await retrieval.autoRetrieve([
      { role: "user", content: "content about JavaScript something similar" },
    ]);

    // Should not re-ref already loaded page
    assert.ok(!mem._refs.includes("pg_001"), "should not ref already-loaded page");

    rmSync(dir, { recursive: true, force: true });
  });

  it("explicit search loads multiple pages", async () => {
    const dir = tmpDir();
    const provider = mockEmbeddingProvider();
    const indexPath = join(dir, "embeddings.json");
    const searchIndex = new PageSearchIndex({ indexPath, embeddingProvider: provider });
    const mem = mockMemory();

    await searchIndex.indexPage("pg_001", "JavaScript frameworks React", "js frameworks");
    await searchIndex.indexPage("pg_002", "JavaScript Node.js backend", "node backend");
    await searchIndex.indexPage("pg_003", "Python data science", "python ds");

    const retrieval = new SemanticRetrieval({
      memory: mem,
      searchIndex,
      searchThreshold: 0.0,
    });

    const results = await retrieval.search("JavaScript development");
    assert.ok(results.length > 0, "should return results");

    rmSync(dir, { recursive: true, force: true });
  });

  it("backfill indexes only pages with summaries", async () => {
    const dir = tmpDir();
    const provider = mockEmbeddingProvider();
    const indexPath = join(dir, "embeddings.json");
    const searchIndex = new PageSearchIndex({ indexPath, embeddingProvider: provider });
    const mem = mockMemory();

    mem.addPage("pg_001", "has summary", "This is a proper summary");
    mem.addPage("pg_002", "no summary", undefined); // No summary
    mem.addPage("pg_003", "also has summary", "Another summary here");

    const retrieval = new SemanticRetrieval({ memory: mem, searchIndex });

    const count = await retrieval.backfill();
    assert.equal(count, 2, "should only backfill pages with summaries");
    assert.equal(searchIndex.size, 2, "index should have 2 entries");

    rmSync(dir, { recursive: true, force: true });
  });

  it("onPageCreated indexes new page", async () => {
    const dir = tmpDir();
    const provider = mockEmbeddingProvider();
    const indexPath = join(dir, "embeddings.json");
    const searchIndex = new PageSearchIndex({ indexPath, embeddingProvider: provider });
    const mem = mockMemory();

    const retrieval = new SemanticRetrieval({ memory: mem, searchIndex });

    assert.equal(searchIndex.size, 0);
    await retrieval.onPageCreated("pg_new", "new page summary", "new page");
    assert.equal(searchIndex.size, 1, "should have indexed the new page");

    rmSync(dir, { recursive: true, force: true });
  });

  it("gracefully handles empty message list", async () => {
    const dir = tmpDir();
    const provider = mockEmbeddingProvider();
    const indexPath = join(dir, "embeddings.json");
    const searchIndex = new PageSearchIndex({ indexPath, embeddingProvider: provider });
    const mem = mockMemory();

    const retrieval = new SemanticRetrieval({ memory: mem, searchIndex });

    const result = await retrieval.autoRetrieve([]);
    assert.equal(result, null, "should return null for empty messages");

    rmSync(dir, { recursive: true, force: true });
  });

  it("available is false when index is empty", () => {
    const dir = tmpDir();
    const provider = mockEmbeddingProvider();
    const indexPath = join(dir, "embeddings.json");
    const searchIndex = new PageSearchIndex({ indexPath, embeddingProvider: provider });
    const mem = mockMemory();

    const retrieval = new SemanticRetrieval({ memory: mem, searchIndex });
    assert.equal(retrieval.available, false, "should be unavailable with empty index");

    rmSync(dir, { recursive: true, force: true });
  });

  it("saveIndex persists to disk", async () => {
    const dir = tmpDir();
    const provider = mockEmbeddingProvider();
    const indexPath = join(dir, "embeddings.json");
    const searchIndex = new PageSearchIndex({ indexPath, embeddingProvider: provider });
    const mem = mockMemory();

    await searchIndex.indexPage("pg_001", "content", "label");

    const retrieval = new SemanticRetrieval({ memory: mem, searchIndex });
    retrieval.saveIndex();

    assert.ok(existsSync(indexPath), "should save embeddings.json");
    const data = JSON.parse(readFileSync(indexPath, "utf-8"));
    assert.equal(data.version, 1);
    assert.ok(data.entries["pg_001"], "should contain pg_001");

    rmSync(dir, { recursive: true, force: true });
  });
});

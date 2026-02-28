/**
 * Snapshot tests for sensory channel views.
 *
 * Each test creates a view with deterministic mock data, renders it,
 * prints the full output, and asserts structural invariants (80-char lines,
 * correct box borders, expected content).
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { ContextMapSource } from "../src/memory/context-map-source.js";
import { TemporalSource } from "../src/memory/temporal-source.js";
import { SelfSource } from "../src/memory/self-source.js";
import { SimpleMemory } from "../src/memory/simple-memory.js";
import { SensoryViewFactory, createDefaultFactory, type ViewDeps } from "../src/memory/sensory-view-factory.js";
import { W } from "../src/memory/box.js";

// --- Helpers ---

function msg(role: string, content: string): { role: string; content: string; from: string } {
  return { role, content, from: role };
}

/** Assert every line is exactly W (80) chars and has correct box borders. */
function assertBoxInvariants(output: string, label: string): void {
  const lines = output.split("\n");
  assert.ok(lines.length >= 3, `${label}: must have at least 3 lines (top, content, bottom)`);
  for (let i = 0; i < lines.length; i++) {
    assert.strictEqual(lines[i].length, W,
      `${label} line ${i}: expected ${W} chars, got ${lines[i].length}\n  → "${lines[i]}"`);
    const ch = lines[i][0];
    if (i === 0) {
      assert.strictEqual(ch, "╔", `${label} line 0: must start with ╔`);
    } else if (i === lines.length - 1) {
      assert.strictEqual(ch, "╚", `${label} last line: must start with ╚`);
    } else {
      assert.ok(ch === "║" || ch === "╠",
        `${label} line ${i}: must start with ║ or ╠, got '${ch}'`);
    }
  }
}

// --- Mock data ---

function virtualMemoryStats(overrides: Record<string, any> = {}) {
  const now = new Date();
  return {
    type: "virtual",
    totalMessages: 25,
    totalTokensEstimate: 8000,
    bufferMessages: 25,
    systemTokens: 600,
    workingMemoryBudget: 12000,
    workingMemoryUsed: 5000,
    pageSlotBudget: 8000,
    pageSlotUsed: 3200,
    pagesAvailable: 5,
    pagesLoaded: 2,
    highRatio: 0.75,
    compactionActive: false,
    thinkingBudget: 0.5,
    lanes: [
      { role: "assistant", tokens: 3000, count: 10 },
      { role: "user", tokens: 2000, count: 8 },
      { role: "tool", tokens: 800, count: 5 },
      { role: "system", tokens: 600, count: 2 },
    ],
    pinnedMessages: 1,
    model: "claude-sonnet-4-6",
    pageDigest: [
      { id: "pg_a1b2c3d4", label: "page 1", tokens: 1200, loaded: true, pinned: false, summary: "Agent discussed memory architecture and page slot design", createdAt: now.toISOString(), messageCount: 5, maxImportance: 0.5, lane: "assistant" },
      { id: "pg_e5f6a7b8", label: "page 2", tokens: 800, loaded: true, pinned: false, summary: "User described requirements for sensory channels", createdAt: now.toISOString(), messageCount: 3, maxImportance: 0.3, lane: "user" },
      { id: "pg_c9d0e1f2", label: "page 3", tokens: 400, loaded: false, pinned: false, summary: "System configuration and initialization", createdAt: now.toISOString(), messageCount: 2, maxImportance: 0.1, lane: "system" },
      { id: "pg_a3b4c5d6", label: "page 4", tokens: 2500, loaded: false, pinned: true, summary: "Critical architecture decision about slot persistence — must not persist ephemeral UI state", createdAt: now.toISOString(), messageCount: 8, maxImportance: 0.9, lane: "assistant" },
      { id: "pg_e7f8a9b0", label: "page 5", tokens: 150, loaded: false, pinned: false, summary: "Tool output from bash command", createdAt: now.toISOString(), messageCount: 1, maxImportance: 0, lane: "tool" },
    ],
    ...overrides,
  };
}

// =============================================================================
// Context view snapshots
// =============================================================================

describe("Context view snapshots", () => {
  test("virtual memory with pages, lanes, and anchors", () => {
    const inner = new SimpleMemory();
    (inner as any).getStats = () => virtualMemoryStats();

    const source = new ContextMapSource(inner);
    const output = source.render();

    console.log("\n=== CONTEXT: virtual memory ===");
    console.log(output);

    assertBoxInvariants(output, "context-virtual");
    assert.ok(output.includes("PAGES"), "should have PAGES header");
    assert.ok(output.includes("LANES"), "should have LANES section");
    assert.ok(output.includes("ANCHORS"), "should have ANCHORS (pg_a3b4c5d6 has importance 0.9)");
    assert.ok(output.includes("SIZE HISTOGRAM"), "should have histogram");
    assert.ok(output.includes("LOAD BUDGET"), "should have load budget");
    assert.ok(output.includes("pg_a1b2c3d4"), "should show page IDs");
    assert.ok(output.includes("🤖"), "should have assistant glyph");
    assert.ok(output.includes("★"), "should have anchor star");
  });

  test("basic memory fallback", () => {
    const inner = new SimpleMemory();
    inner.add(msg("user", "hello"));
    inner.add(msg("assistant", "hi"));

    const source = new ContextMapSource(inner);
    const output = source.render();

    console.log("\n=== CONTEXT: basic memory ===");
    console.log(output);

    assertBoxInvariants(output, "context-basic");
    assert.ok(output.includes("MEMORY"), "should have MEMORY header");
    assert.ok(output.includes("msgs"), "should show message count");
  });

  test("empty page digest", () => {
    const inner = new SimpleMemory();
    (inner as any).getStats = () => virtualMemoryStats({ pageDigest: [], pagesLoaded: 0, pagesAvailable: 0 });

    const source = new ContextMapSource(inner);
    const output = source.render();

    console.log("\n=== CONTEXT: empty pages ===");
    console.log(output);

    assertBoxInvariants(output, "context-empty");
    assert.ok(output.includes("0 total"), "should show 0 total");
    assert.ok(output.includes("no pages"), "should indicate no pages");
  });

  test("drill-down filter for single page", () => {
    const inner = new SimpleMemory();
    (inner as any).getStats = () => virtualMemoryStats();

    const source = new ContextMapSource(inner);
    source.setFilter("pg_a1b2c3d4");
    const output = source.render();

    console.log("\n=== CONTEXT: drill-down pg_a1b2c3d4 ===");
    console.log(output);

    assertBoxInvariants(output, "context-drill");
    assert.ok(output.includes("pg_a1b2c3d4"), "should show target page");
    assert.ok(output.includes("page detail"), "should indicate detail view");
  });
});

// =============================================================================
// Time view snapshots
// =============================================================================

describe("Time view snapshots", () => {
  test("temporal position with session and turns", () => {
    const source = new TemporalSource({
      sessionOrigin: Date.now() - 45 * 60 * 1000, // 45 minutes ago
      maxSessionMs: 2 * 60 * 60 * 1000,
    });
    source.setTurnCount(42);
    source.setMaxTurns(60);

    const output = source.render();

    console.log("\n=== TIME: temporal position ===");
    console.log(output);

    assertBoxInvariants(output, "time");
    assert.ok(output.includes("TIME"), "should have TIME header");
    assert.ok(output.includes("YEAR"), "should have YEAR zoom");
    assert.ok(output.includes("MONTH"), "should have MONTH zoom");
    assert.ok(output.includes("WEEK"), "should have WEEK zoom");
    assert.ok(output.includes("DAY"), "should have DAY zoom");
    assert.ok(output.includes("SESS"), "should have SESS bar");
    assert.ok(output.includes("TURN"), "should have TURN bar");
    assert.ok(output.includes("▲"), "should have cursor markers");
    assert.ok(output.includes("t:42"), "should show turn count");
  });
});

// =============================================================================
// Self view snapshots
// =============================================================================

describe("Self view snapshots", () => {
  test("empty template", () => {
    const source = new SelfSource();
    const output = source.render();

    console.log("\n=== SELF: empty template ===");
    console.log(output);

    assertBoxInvariants(output, "self-empty");
    assert.ok(output.includes("SELF"), "should have SELF header");
    assert.ok(output.includes("current task"), "should have task zone");
    assert.ok(output.includes("open threads"), "should have threads zone");
    assert.ok(output.includes("state"), "should have state zone");
  });

  test("with content", () => {
    const source = new SelfSource();
    source.setContent(
      "Current: Debugging sensory slot corruption\n" +
      "Next: Write snapshot tests for all views\n" +
      "Blocked: Waiting for container restart with v2.10.7"
    );
    const output = source.render();

    console.log("\n=== SELF: with content ===");
    console.log(output);

    assertBoxInvariants(output, "self-content");
    assert.ok(output.includes("SELF"), "should have SELF header");
    assert.ok(output.includes("Debugging"), "should include content");
    assert.ok(output.includes("snapshot tests"), "should include content");
  });
});

// =============================================================================
// Factory tests
// =============================================================================

describe("SensoryViewFactory", () => {
  test("createDefaultFactory registers all 8 views", () => {
    const factory = createDefaultFactory();
    const names = factory.names();

    console.log("\n=== FACTORY: registered views ===");
    for (const spec of factory.specs()) {
      console.log(`  ${spec.name.padEnd(12)} ${spec.width}×${spec.height}  maxTok:${String(spec.maxTokens).padStart(3)}  enabled:${spec.enabled}  viewable:${spec.viewable}`);
    }

    assert.strictEqual(names.length, 8, "should have 8 registered views");
    assert.ok(names.includes("context"), "should include context");
    assert.ok(names.includes("time"), "should include time");
    assert.ok(names.includes("config"), "should include config");
    assert.ok(names.includes("self"), "should include self");
    assert.ok(names.includes("tasks"), "should include tasks");
    assert.ok(names.includes("social"), "should include social");
    assert.ok(names.includes("spend"), "should include spend");
    assert.ok(names.includes("violations"), "should include violations");
  });

  test("self is non-viewable, others are viewable", () => {
    const factory = createDefaultFactory();
    const nonViewable = factory.nonViewableNames();

    assert.deepStrictEqual(nonViewable, ["self"], "only 'self' should be non-viewable");

    for (const name of ["context", "time", "config", "tasks", "social", "spend", "violations"]) {
      const spec = factory.getSpec(name);
      assert.ok(spec, `${name} should have a spec`);
      assert.strictEqual(spec!.viewable, true, `${name} should be viewable`);
    }
  });

  test("factory creates working sources for testable views", () => {
    const inner = new SimpleMemory();
    inner.add(msg("user", "test"));
    const deps: ViewDeps = { memory: inner };

    // Create views that don't depend on global state
    for (const name of ["context", "time", "self"]) {
      const source = factory_create(name, deps);
      assert.ok(source, `${name} should create a source`);
      assert.ok(typeof source.poll === "function", `${name} source should have poll()`);
      assert.ok(typeof source.destroy === "function", `${name} source should have destroy()`);
    }
  });

  test("getSpec returns correct config", () => {
    const factory = createDefaultFactory();

    const ctx = factory.getSpec("context");
    assert.ok(ctx);
    assert.strictEqual(ctx!.width, 80);
    assert.strictEqual(ctx!.height, 40);
    assert.strictEqual(ctx!.maxTokens, 800);
    assert.strictEqual(ctx!.enabled, true);

    const self = factory.getSpec("self");
    assert.ok(self);
    assert.strictEqual(self!.viewable, false);
    assert.strictEqual(self!.enabled, false);

    assert.strictEqual(factory.getSpec("nonexistent"), undefined);
  });
});

/** Helper — avoids recreating factory in each sub-test. */
function factory_create(name: string, deps: ViewDeps) {
  const factory = createDefaultFactory();
  return factory.create(name, deps);
}

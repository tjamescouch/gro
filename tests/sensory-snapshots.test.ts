/**
 * Snapshot tests for sensory channel views.
 *
 * Each test creates a view with deterministic mock data, renders it,
 * prints the full output, and asserts structural invariants (82-char lines,
 * correct box borders, expected content).
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { ContextMapSource } from "../src/memory/context-map-source.js";
import { TemporalSource } from "../src/memory/temporal-source.js";
import { SelfSource } from "../src/memory/self-source.js";
import { SimpleMemory } from "../src/memory/simple-memory.js";
import { SensoryMemory } from "../src/memory/sensory-memory.js";
import { SensoryViewFactory, createDefaultFactory, type ViewDeps } from "../src/memory/sensory-view-factory.js";
import { W } from "../src/memory/box.js";

// --- Helpers ---

function msg(role: string, content: string): { role: string; content: string; from: string } {
  return { role, content, from: role };
}

/** Assert every line is exactly W (82) chars and has correct box borders. */
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

  test("many pages — all 6 sections within 40 lines", () => {
    const now = new Date();
    // Generate 50 pages to force height budgeting
    const manyPages = Array.from({ length: 50 }, (_, i) => ({
      id: `pg_${String(i).padStart(8, "0")}`,
      label: `page ${i + 1}`,
      tokens: 200 + i * 50,
      loaded: i < 3,
      pinned: i === 10,
      summary: `Page ${i + 1} content about topic ${i}`,
      createdAt: now.toISOString(),
      messageCount: 2 + (i % 5),
      maxImportance: i === 10 ? 0.95 : 0.2,
      lane: ["assistant", "user", "system", "tool"][i % 4],
    }));

    const inner = new SimpleMemory();
    (inner as any).getStats = () => virtualMemoryStats({
      pageDigest: manyPages,
      pagesLoaded: 3,
      pagesAvailable: 50,
    });

    const source = new ContextMapSource(inner, { maxLines: 40 });
    const output = source.render();

    console.log("\n=== CONTEXT: 50 pages (height-budgeted) ===");
    console.log(output);

    const lines = output.split("\n");
    assert.ok(lines.length <= 40, `should fit in 40 lines, got ${lines.length}`);
    assertBoxInvariants(output, "context-many");
    assert.ok(output.includes("PAGES"), "should have PAGES header");
    assert.ok(output.includes("LANES"), "should have LANES section");
    assert.ok(output.includes("ANCHORS"), "should have ANCHORS (page 10 has importance 0.95)");
    assert.ok(output.includes("SIZE HISTOGRAM"), "should have histogram");
    assert.ok(output.includes("LOAD BUDGET"), "should have load budget");
    assert.ok(output.includes("+"), "should show truncation indicator for remaining pages");
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
  test("createDefaultFactory registers all 9 views", () => {
    const factory = createDefaultFactory();
    const names = factory.names();

    console.log("\n=== FACTORY: registered views ===");
    for (const spec of factory.specs()) {
      console.log(`  ${spec.name.padEnd(12)} ${spec.width}×${spec.height}  maxTok:${String(spec.maxTokens).padStart(3)}  enabled:${spec.enabled}  viewable:${spec.viewable}`);
    }

    assert.strictEqual(names.length, 9, "should have 9 registered views");
    assert.ok(names.includes("context"), "should include context");
    assert.ok(names.includes("time"), "should include time");
    assert.ok(names.includes("config"), "should include config");
    assert.ok(names.includes("self"), "should include self");
    assert.ok(names.includes("tasks"), "should include tasks");
    assert.ok(names.includes("social"), "should include social");
    assert.ok(names.includes("spend"), "should include spend");
    assert.ok(names.includes("violations"), "should include violations");
    assert.ok(names.includes("awareness"), "should include awareness");
  });

  test("all channels are viewable", () => {
    const factory = createDefaultFactory();
    const nonViewable = factory.nonViewableNames();

    assert.deepStrictEqual(nonViewable, [], "no channels should be non-viewable");

    for (const name of ["context", "time", "config", "tasks", "social", "spend", "violations", "self"]) {
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
    assert.strictEqual(ctx!.width, 82);
    assert.strictEqual(ctx!.height, 40);
    assert.strictEqual(ctx!.maxTokens, 800);
    assert.strictEqual(ctx!.enabled, true);

    const self = factory.getSpec("self");
    assert.ok(self);
    assert.strictEqual(self!.viewable, true);
    assert.strictEqual(self!.enabled, false);

    assert.strictEqual(factory.getSpec("nonexistent"), undefined);
  });
});

/** Helper — avoids recreating factory in each sub-test. */
function factory_create(name: string, deps: ViewDeps) {
  const factory = createDefaultFactory();
  return factory.create(name, deps);
}

// =============================================================================
// Integration tests — full SensoryMemory pipeline
// =============================================================================

/**
 * Assert that every line in a section's content is at most `maxWidth` chars.
 * This catches character-level slicing that destroys box-drawing structure.
 */
function assertNoLineTruncation(sectionContent: string, sectionName: string, maxWidth: number): void {
  const lines = sectionContent.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Lines should be exactly maxWidth (padded by enforceGrid) or shorter (e.g., section headers)
    assert.ok(line.length <= maxWidth,
      `${sectionName} line ${i}: expected ≤${maxWidth} chars, got ${line.length}\n  → "${line}"`);
  }
}

/**
 * Extract individual channel sections from the sensory buffer string.
 * Returns Map<channelName, contentString>.
 */
function parseSensoryBuffer(buffer: string): Map<string, string> {
  const sections = new Map<string, string>();
  const regex = /\[(\w+)\]\n([\s\S]*?)(?=\n\n\[|\n--- END SENSORY BUFFER ---)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(buffer)) !== null) {
    sections.set(match[1], match[2]);
  }
  return sections;
}

/** Create a SensoryMemory with default factory channels and mock data. */
function createTestSensory(overrides: Record<string, any> = {}): SensoryMemory {
  const inner = new SimpleMemory();
  inner.add(msg("system", "You are a test agent."));
  inner.add(msg("user", "hello"));
  inner.add(msg("assistant", "hi there"));

  // Give it virtual memory stats so context view renders the full 6-section panel
  (inner as any).getStats = () => virtualMemoryStats(overrides);

  const sensory = new SensoryMemory(inner, { totalBudget: 1200 });
  const factory = createDefaultFactory();
  const deps: ViewDeps = { memory: inner };

  for (const spec of factory.specs()) {
    sensory.addChannel({
      name: spec.name,
      maxTokens: spec.maxTokens,
      updateMode: spec.updateMode,
      content: "",
      enabled: spec.enabled,
      source: factory.create(spec.name, deps),
      width: spec.width,
      height: spec.height,
      viewable: spec.viewable,
    });
  }

  // Default camera slots
  sensory.setSlot(0, "context");
  sensory.setSlot(1, "time");
  sensory.setSlot(2, "awareness");

  return sensory;
}

describe("Integration: SensoryMemory full pipeline", () => {
  test("all 3 default slots present in sensory buffer", async () => {
    const sensory = createTestSensory();
    await sensory.pollSources();

    const msgs = sensory.messages();
    const sensoryMsg = msgs.find(m => m.from === "SensoryMemory");
    assert.ok(sensoryMsg, "should inject a SensoryMemory message");

    const buffer = sensoryMsg!.content as string;
    console.log("\n=== INTEGRATION: full sensory buffer ===");
    console.log(buffer);

    assert.ok(buffer.includes("--- SENSORY BUFFER ---"), "should have buffer start marker");
    assert.ok(buffer.includes("--- END SENSORY BUFFER ---"), "should have buffer end marker");
    assert.ok(buffer.includes("[context]"), "should have context slot");
    assert.ok(buffer.includes("[time]"), "should have time slot");
    assert.ok(buffer.includes("[awareness]"), "should have awareness slot");
  });

  test("no line exceeds W chars in any slot", async () => {
    const sensory = createTestSensory();
    await sensory.pollSources();

    const msgs = sensory.messages();
    const sensoryMsg = msgs.find(m => m.from === "SensoryMemory");
    assert.ok(sensoryMsg, "should inject a SensoryMemory message");

    const buffer = sensoryMsg!.content as string;
    const sections = parseSensoryBuffer(buffer);

    assert.ok(sections.size >= 3, `should have at least 3 sections, got ${sections.size}`);

    for (const [name, content] of sections) {
      assertNoLineTruncation(content, name, W);
    }
  });

  test("box structure intact in each slot after pipeline", async () => {
    const sensory = createTestSensory();
    await sensory.pollSources();

    const msgs = sensory.messages();
    const sensoryMsg = msgs.find(m => m.from === "SensoryMemory");
    const buffer = sensoryMsg!.content as string;
    const sections = parseSensoryBuffer(buffer);

    // Context and time sections should have valid box borders
    for (const name of ["context", "time", "awareness"]) {
      const content = sections.get(name);
      assert.ok(content, `${name} section should exist`);

      // Find the box-drawn portion (lines starting with box chars)
      const lines = content!.split("\n").filter(l => l.length > 0);
      const boxLines = lines.filter(l => /^[╔╗╚╝║╠╣═]/.test(l));
      assert.ok(boxLines.length >= 3,
        `${name}: should have at least 3 box lines (top, content, bottom), got ${boxLines.length}`);

      // First box line should be top border
      const firstBox = boxLines[0];
      assert.ok(firstBox.startsWith("╔"), `${name}: first box line should start with ╔, got '${firstBox[0]}'`);
      assert.strictEqual(firstBox.length, W, `${name}: top border should be ${W} chars, got ${firstBox.length}`);

      // Last box line should be bottom border
      const lastBox = boxLines[boxLines.length - 1];
      assert.ok(lastBox.startsWith("╚"), `${name}: last box line should start with ╚, got '${lastBox[0]}'`);
      assert.strictEqual(lastBox.length, W, `${name}: bottom border should be ${W} chars, got ${lastBox.length}`);

      // All middle box lines should start with ║ or ╠
      for (let i = 1; i < boxLines.length - 1; i++) {
        const ch = boxLines[i][0];
        assert.ok(ch === "║" || ch === "╠",
          `${name} box line ${i}: should start with ║ or ╠, got '${ch}'\n  → "${boxLines[i]}"`);
        assert.strictEqual(boxLines[i].length, W,
          `${name} box line ${i}: should be ${W} chars, got ${boxLines[i].length}\n  → "${boxLines[i]}"`);
      }
    }
  });

  test("context shows all 6 sections even with many pages", async () => {
    const now = new Date();
    const manyPages = Array.from({ length: 100 }, (_, i) => ({
      id: `pg_${String(i).padStart(8, "0")}`,
      label: `page ${i + 1}`,
      tokens: 200 + i * 30,
      loaded: i < 5,
      pinned: i === 20,
      summary: `Discussion topic ${i} about architecture`,
      createdAt: now.toISOString(),
      messageCount: 3,
      maxImportance: i === 20 ? 0.9 : 0.1,
      lane: ["assistant", "user", "system", "tool"][i % 4],
    }));

    const sensory = createTestSensory({
      pageDigest: manyPages,
      pagesLoaded: 5,
      pagesAvailable: 100,
    });
    await sensory.pollSources();

    const msgs = sensory.messages();
    const sensoryMsg = msgs.find(m => m.from === "SensoryMemory");
    const buffer = sensoryMsg!.content as string;
    const sections = parseSensoryBuffer(buffer);
    const contextContent = sections.get("context")!;

    console.log("\n=== INTEGRATION: context with 100 pages ===");
    // Print just the box lines (skip enforceGrid padding)
    const boxLines = contextContent.split("\n").filter(l => /^[╔╗╚╝║╠╣═]/.test(l));
    console.log(boxLines.join("\n"));

    assert.ok(contextContent.includes("PAGES"), "should have PAGES header");
    assert.ok(contextContent.includes("LANES"), "should have LANES section");
    assert.ok(contextContent.includes("ANCHORS"), "should have ANCHORS");
    assert.ok(contextContent.includes("SIZE HISTOGRAM"), "should have histogram");
    assert.ok(contextContent.includes("LOAD BUDGET"), "should have load budget");
    assert.ok(contextContent.includes("100 total"), "should show 100 total pages");
  });

  test("disabling a slot removes it from buffer", async () => {
    const sensory = createTestSensory();
    sensory.setSlot(2, null); // disable awareness slot
    await sensory.pollSources();

    const msgs = sensory.messages();
    const sensoryMsg = msgs.find(m => m.from === "SensoryMemory");
    const buffer = sensoryMsg!.content as string;

    assert.ok(buffer.includes("[context]"), "should have context");
    assert.ok(buffer.includes("[time]"), "should have time");
    assert.ok(!buffer.includes("[awareness]"), "should NOT have awareness when slot disabled");
  });
});

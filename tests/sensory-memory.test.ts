/**
 * Tests for SensoryMemory decorator and ContextMapSource.
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import type { ChatMessage } from "../src/drivers/types.js";
import { SimpleMemory } from "../src/memory/simple-memory.js";
import { SensoryMemory, type SensoryChannel, type SensorySource } from "../src/memory/sensory-memory.js";
import { ContextMapSource } from "../src/memory/context-map-source.js";

function msg(role: string, content: string, from?: string): ChatMessage {
  return { role, content, from: from ?? role };
}

/** Stub source that returns fixed content. */
function stubSource(content: string): SensorySource {
  return {
    async poll() { return content; },
    destroy() {},
  };
}

describe("SensoryMemory", () => {
  test("delegates add/messages to inner memory", async () => {
    const inner = new SimpleMemory("System prompt");
    const sensory = new SensoryMemory(inner);

    await sensory.add(msg("user", "hello"));
    await sensory.add(msg("assistant", "hi"));

    // Inner should have the messages
    const innerMsgs = inner.messages();
    assert.strictEqual(innerMsgs.length, 3); // system + 2

    // Sensory messages() should include inner messages
    const msgs = sensory.messages();
    assert.ok(msgs.length >= 3);
    assert.strictEqual(msgs[0].role, "system");
    assert.strictEqual(msgs[0].content, "System prompt");
  });

  test("injects sensory buffer at index 1 after system prompt", async () => {
    const inner = new SimpleMemory("System prompt");
    const sensory = new SensoryMemory(inner);

    sensory.addChannel({
      name: "test",
      maxTokens: 200,
      updateMode: "manual",
      content: "test content",
      enabled: true,
    });

    await sensory.add(msg("user", "hello"));

    const msgs = sensory.messages();
    assert.strictEqual(msgs[0].role, "system");
    assert.strictEqual(msgs[0].content, "System prompt");
    assert.strictEqual(msgs[1].role, "system");
    assert.ok(msgs[1].content.includes("SENSORY BUFFER"));
    assert.ok(msgs[1].content.includes("test content"));
    assert.strictEqual(msgs[2].content, "hello");
  });

  test("sensory buffer at index 0 when no system prompt", async () => {
    const inner = new SimpleMemory();
    const sensory = new SensoryMemory(inner);

    sensory.addChannel({
      name: "test",
      maxTokens: 200,
      updateMode: "manual",
      content: "test content",
      enabled: true,
    });

    await sensory.add(msg("user", "hello"));

    const msgs = sensory.messages();
    // First message should be sensory (no system prompt to precede it)
    assert.strictEqual(msgs[0].role, "system");
    assert.ok(msgs[0].content.includes("SENSORY BUFFER"));
    assert.strictEqual(msgs[1].content, "hello");
  });

  test("no sensory message injected when all channels are empty", async () => {
    const inner = new SimpleMemory("System prompt");
    const sensory = new SensoryMemory(inner);

    sensory.addChannel({
      name: "empty",
      maxTokens: 200,
      updateMode: "manual",
      content: "",
      enabled: true,
    });

    await sensory.add(msg("user", "hello"));

    const msgs = sensory.messages();
    // Should be same as inner: system + user
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].content, "System prompt");
    assert.strictEqual(msgs[1].content, "hello");
  });

  test("channel enable/disable controls what appears in render", async () => {
    const inner = new SimpleMemory("System prompt");
    const sensory = new SensoryMemory(inner);

    sensory.addChannel({
      name: "ch1",
      maxTokens: 200,
      updateMode: "manual",
      content: "channel 1 data",
      enabled: true,
    });

    sensory.addChannel({
      name: "ch2",
      maxTokens: 200,
      updateMode: "manual",
      content: "channel 2 data",
      enabled: true,
    });

    // Both enabled
    let msgs = sensory.messages();
    let sensoryMsg = msgs[1];
    assert.ok(sensoryMsg.content.includes("channel 1 data"));
    assert.ok(sensoryMsg.content.includes("channel 2 data"));

    // Disable ch1
    sensory.setEnabled("ch1", false);
    msgs = sensory.messages();
    sensoryMsg = msgs[1];
    assert.ok(!sensoryMsg.content.includes("channel 1 data"));
    assert.ok(sensoryMsg.content.includes("channel 2 data"));
  });

  test("per-channel token budget: grid enforcement bounds content", () => {
    const inner = new SimpleMemory();
    const sensory = new SensoryMemory(inner, { avgCharsPerToken: 1 });

    sensory.addChannel({
      name: "limited",
      maxTokens: 10,
      updateMode: "manual",
      content: "",
      enabled: true,
      width: 20,
      height: 5,
    });

    // Push content exceeding budget — grid enforcement clips to width × height
    const longContent = "A".repeat(500);
    sensory.update("limited", longContent);

    const msgs = sensory.messages();
    const sensoryMsg = msgs[0]; // no system prompt
    assert.ok(sensoryMsg.content.includes("SENSORY BUFFER"));
    // Grid enforcement clips to 20×5 = ~100 chars + newlines + buffer wrapper
    // Much smaller than the raw 500-char input
    assert.ok(sensoryMsg.content.length < 300,
      `Content should be bounded by grid enforcement, got ${sensoryMsg.content.length} chars`);
  });

  test("pollSources calls every_turn sources", async () => {
    const inner = new SimpleMemory();
    const sensory = new SensoryMemory(inner);

    let pollCount = 0;
    const source: SensorySource = {
      async poll() { pollCount++; return `poll result ${pollCount}`; },
      destroy() {},
    };

    sensory.addChannel({
      name: "polled",
      maxTokens: 200,
      updateMode: "every_turn",
      content: "",
      enabled: true,
      source,
    });

    await sensory.pollSources();
    assert.strictEqual(pollCount, 1);

    const msgs = sensory.messages();
    assert.ok(msgs[0].content.includes("poll result 1"));

    await sensory.pollSources();
    assert.strictEqual(pollCount, 2);
  });

  test("manual channels are not polled", async () => {
    const inner = new SimpleMemory();
    const sensory = new SensoryMemory(inner);

    let pollCount = 0;
    const source: SensorySource = {
      async poll() { pollCount++; return "should not be called"; },
      destroy() {},
    };

    sensory.addChannel({
      name: "manual",
      maxTokens: 200,
      updateMode: "manual",
      content: "manual content",
      enabled: true,
      source,
    });

    await sensory.pollSources();
    assert.strictEqual(pollCount, 0);
  });

  test("hot-swap preserves channels via setInner", async () => {
    const inner1 = new SimpleMemory("System 1");
    const sensory = new SensoryMemory(inner1);

    sensory.addChannel({
      name: "persist",
      maxTokens: 200,
      updateMode: "manual",
      content: "persistent data",
      enabled: true,
    });

    await inner1.add(msg("user", "msg in inner1"));

    // Swap inner
    const inner2 = new SimpleMemory("System 2");
    await inner2.add(msg("user", "msg in inner2"));
    sensory.setInner(inner2);

    const msgs = sensory.messages();
    // Should use inner2's messages
    assert.ok(msgs.some(m => m.content === "msg in inner2"));
    // Channel should still be present
    const sensoryMsg = msgs.find(m => m.content.includes("SENSORY BUFFER"));
    assert.ok(sensoryMsg);
    assert.ok(sensoryMsg!.content.includes("persistent data"));
  });

  test("onSenseMarker disables/enables channels", async () => {
    const inner = new SimpleMemory();
    const sensory = new SensoryMemory(inner);

    sensory.addChannel({
      name: "ctx",
      maxTokens: 200,
      updateMode: "manual",
      content: "context data",
      enabled: true,
    });

    // Disable specific channel: channel first, action second
    sensory.onSenseMarker("ctx", "off");
    let msgs = sensory.messages();
    assert.ok(!msgs.some(m => m.content?.includes("SENSORY BUFFER")));

    // Re-enable: channel first, action second
    sensory.onSenseMarker("ctx", "on");
    msgs = sensory.messages();
    assert.ok(msgs.some(m => m.content?.includes("context data")));
  });

  test("onSenseMarker disables all when no channel specified", async () => {
    const inner = new SimpleMemory();
    const sensory = new SensoryMemory(inner);

    sensory.addChannel({ name: "a", maxTokens: 200, updateMode: "manual", content: "aaa", enabled: true });
    sensory.addChannel({ name: "b", maxTokens: 200, updateMode: "manual", content: "bbb", enabled: true });

    // Disable all: action only, no channel
    sensory.onSenseMarker("off", "");
    let msgs = sensory.messages();
    assert.ok(!msgs.some(m => m.content?.includes("SENSORY BUFFER")));

    // Re-enable all
    sensory.onSenseMarker("on", "");
    msgs = sensory.messages();
    assert.ok(msgs.some(m => m.content?.includes("aaa")));
    assert.ok(msgs.some(m => m.content?.includes("bbb")));
  });

  test("setInner updates ContextMapSource memory reference", async () => {
    const inner1 = new SimpleMemory();
    await inner1.add(msg("user", "one"));

    const sensory = new SensoryMemory(inner1, { totalBudget: 500 });
    const ctxMap = new ContextMapSource(inner1);
    sensory.addChannel({
      name: "context",
      maxTokens: 300,
      updateMode: "every_turn",
      content: "",
      enabled: true,
      source: ctxMap,
    });

    await sensory.pollSources();
    let msgs = sensory.messages();
    let buf = msgs.find(m => m.content?.includes("SENSORY BUFFER"));
    assert.ok(buf!.content.includes("1 msgs"));

    // Swap inner — setInner should call setMemory on the ContextMapSource
    const inner2 = new SimpleMemory();
    await inner2.add(msg("user", "a"));
    await inner2.add(msg("user", "b"));
    await inner2.add(msg("user", "c"));
    sensory.setInner(inner2);

    await sensory.pollSources();
    msgs = sensory.messages();
    buf = msgs.find(m => m.content?.includes("SENSORY BUFFER"));
    assert.ok(buf!.content.includes("3 msgs"));
  });

  test("getStats delegates to inner", () => {
    const inner = new SimpleMemory();
    const sensory = new SensoryMemory(inner);

    const stats = sensory.getStats();
    assert.strictEqual(stats.type, "simple");
  });

  test("addIfNotExists delegates correctly", async () => {
    const inner = new SimpleMemory();
    const sensory = new SensoryMemory(inner);

    await sensory.add(msg("user", "hello"));
    await sensory.addIfNotExists(msg("user", "hello"));
    await sensory.addIfNotExists(msg("user", "world"));

    const msgs = inner.messages();
    assert.strictEqual(msgs.length, 2);
  });
});

describe("ContextMapSource", () => {
  /** Helper to build a virtual stats mock with pageDigest. */
  function virtualStats(overrides: Record<string, any> = {}) {
    const now = new Date();
    return {
      type: "virtual",
      totalMessages: 20,
      totalTokensEstimate: 5000,
      bufferMessages: 20,
      systemTokens: 500,
      workingMemoryBudget: 8000,
      workingMemoryUsed: 4000,
      pageSlotBudget: 6000,
      pageSlotUsed: 2400,
      pagesAvailable: 5,
      pagesLoaded: 2,
      highRatio: 0.75,
      compactionActive: false,
      thinkingBudget: 0.5,
      lanes: [
        { role: "assistant", tokens: 2000, count: 8 },
        { role: "user", tokens: 1500, count: 7 },
        { role: "tool", tokens: 500, count: 5 },
      ],
      pinnedMessages: 1,
      model: "claude-sonnet-4-5-20250514",
      pageDigest: [
        { id: "pg_001", label: "page 1", tokens: 1200, loaded: true, pinned: false, summary: "Discussion about testing", createdAt: now.toISOString(), messageCount: 5, maxImportance: 0.5, lane: "assistant" },
        { id: "pg_002", label: "page 2", tokens: 800, loaded: true, pinned: false, summary: "User preferences", createdAt: now.toISOString(), messageCount: 3, maxImportance: 0.3, lane: "user" },
        { id: "pg_003", label: "page 3", tokens: 400, loaded: false, pinned: false, summary: "System configuration", createdAt: now.toISOString(), messageCount: 2, maxImportance: 0.1, lane: "system" },
      ],
      ...overrides,
    };
  }

  test("renders basic stats for SimpleMemory", async () => {
    const inner = new SimpleMemory();
    await inner.add(msg("user", "hello world"));
    await inner.add(msg("assistant", "hi there"));

    const source = new ContextMapSource(inner);
    const output = await source.poll();

    assert.ok(output);
    // Basic render: box with MEMORY header
    assert.ok(output!.includes("MEMORY"), "should include MEMORY header");
    assert.ok(output!.includes("msgs"), "should include message count");
    assert.ok(output!.includes("╔"), "should have box top border");
    assert.ok(output!.includes("╚"), "should have box bottom border");
    assert.ok(output!.includes("║"), "should have box side borders");
  });

  test("renders virtual stats with 6-section page viewer", async () => {
    const inner = new SimpleMemory();
    (inner as any).getStats = () => virtualStats();

    const source = new ContextMapSource(inner);
    const output = await source.poll();

    assert.ok(output);
    // All 6 sections should be present
    assert.ok(output!.includes("PAGES"), "should have PAGES header");
    assert.ok(output!.includes("LANES"), "should have LANES section divider");
    assert.ok(output!.includes("SIZE HISTOGRAM"), "should have histogram section");
    assert.ok(output!.includes("LOAD BUDGET"), "should have load budget section");

    // Lane glyphs
    assert.ok(output!.includes("🤖"), "should have assistant glyph");
    assert.ok(output!.includes("👤"), "should have user glyph");
    assert.ok(output!.includes("🔧"), "should have tool glyph");

    // Lane abbreviations
    assert.ok(output!.includes("asst"), "should have assistant lane label");
    assert.ok(output!.includes("user"), "should have user lane label");
    assert.ok(output!.includes("tool"), "should have tool lane label");

    // Page rows
    assert.ok(output!.includes("pg_001"), "should show first page ID");
    assert.ok(output!.includes("pg_003"), "should show third page ID");

    // Fill bars (█ and ░)
    assert.ok(output!.includes("█"), "should have filled bar segments");
    assert.ok(output!.includes("░"), "should have empty bar segments");

    // Box drawing
    assert.ok(output!.includes("╔"), "should have top border");
    assert.ok(output!.includes("╚"), "should have bottom border");
    assert.ok(output!.includes("╠"), "should have section dividers");
  });

  test("render stays under 1200 tokens", async () => {
    const now = new Date();
    const pages = [];
    for (let i = 0; i < 14; i++) {
      pages.push({
        id: `pg_${String(i).padStart(3, "0")}`,
        label: `page ${i}`,
        tokens: 300 + i * 400,
        loaded: i < 3,
        pinned: i === 0,
        summary: `Summary for page ${i} with some content`,
        createdAt: new Date(now.getTime() - i * 3600000).toISOString(),
        messageCount: 2 + i,
        maxImportance: i === 5 ? 0.9 : 0.3,
        lane: ["assistant", "user", "tool", "system"][i % 4],
      });
    }

    const inner = new SimpleMemory();
    (inner as any).getStats = () => virtualStats({
      totalMessages: 100,
      totalTokensEstimate: 25000,
      systemTokens: 2800,
      workingMemoryBudget: 32000,
      workingMemoryUsed: 25000,
      pageSlotBudget: 16000,
      pageSlotUsed: 4800,
      pagesAvailable: 14,
      pagesLoaded: 3,
      compactionActive: true,
      lanes: [
        { role: "assistant", tokens: 11000, count: 30 },
        { role: "user", tokens: 6000, count: 25 },
        { role: "tool", tokens: 5000, count: 20 },
        { role: "system", tokens: 2800, count: 10 },
      ],
      pageDigest: pages,
    });

    const source = new ContextMapSource(inner);
    const output = await source.poll();

    assert.ok(output);
    // Rough token estimate: chars / 2.8
    const estimatedTokens = output!.length / 2.8;
    assert.ok(estimatedTokens < 1200, `Render too long: ~${Math.round(estimatedTokens)} tokens (${output!.length} chars)`);
  });

  test("anchors section shows high-importance pages", async () => {
    const now = new Date();
    const inner = new SimpleMemory();
    (inner as any).getStats = () => virtualStats({
      pageDigest: [
        { id: "pg_anchor1", label: "anchor 1", tokens: 500, loaded: true, pinned: false, summary: "Critical decision about architecture", createdAt: now.toISOString(), messageCount: 4, maxImportance: 0.9, lane: "assistant" },
        { id: "pg_normal", label: "normal", tokens: 300, loaded: false, pinned: false, summary: "Regular conversation", createdAt: now.toISOString(), messageCount: 2, maxImportance: 0.3, lane: "user" },
        { id: "pg_anchor2", label: "anchor 2", tokens: 800, loaded: false, pinned: false, summary: "Key user requirement", createdAt: now.toISOString(), messageCount: 6, maxImportance: 0.85, lane: "user" },
      ],
    });

    const source = new ContextMapSource(inner);
    const output = await source.poll();

    assert.ok(output);
    assert.ok(output!.includes("ANCHORS"), "should have anchors section");
    assert.ok(output!.includes("pg_anchor1"), "should show first anchor page");
    assert.ok(output!.includes("pg_anchor2"), "should show second anchor page");
    assert.ok(output!.includes("★"), "should have star marker for anchors");
  });

  test("histogram shows page size distribution", async () => {
    const now = new Date();
    const inner = new SimpleMemory();
    (inner as any).getStats = () => virtualStats({
      pageDigest: [
        { id: "pg_tiny", label: "tiny", tokens: 50, loaded: false, pinned: false, summary: "Tiny page", createdAt: now.toISOString(), messageCount: 1, maxImportance: 0, lane: "system" },
        { id: "pg_small", label: "small", tokens: 500, loaded: false, pinned: false, summary: "Small page", createdAt: now.toISOString(), messageCount: 2, maxImportance: 0, lane: "user" },
        { id: "pg_med", label: "medium", tokens: 2500, loaded: true, pinned: false, summary: "Medium page", createdAt: now.toISOString(), messageCount: 5, maxImportance: 0, lane: "assistant" },
        { id: "pg_big", label: "large", tokens: 5500, loaded: true, pinned: false, summary: "Large page", createdAt: now.toISOString(), messageCount: 10, maxImportance: 0, lane: "tool" },
      ],
    });

    const source = new ContextMapSource(inner);
    const output = await source.poll();

    assert.ok(output);
    assert.ok(output!.includes("SIZE HISTOGRAM"), "should have histogram section");
    assert.ok(output!.includes("<100"), "should have tiny bucket");
    assert.ok(output!.includes("<1000"), "should have small bucket");
    assert.ok(output!.includes("<5000"), "should have medium bucket");
    assert.ok(output!.includes("pages"), "should show page counts in buckets");
  });

  test("graceful degradation for basic memory types", async () => {
    const inner = new SimpleMemory();
    await inner.add(msg("user", "hello"));

    const source = new ContextMapSource(inner);
    const output = await source.poll();

    // Should render without error as a compact MEMORY box
    assert.ok(output);
    assert.ok(output!.includes("MEMORY"), "should include MEMORY header for basic type");
    assert.ok(output!.includes("msgs"), "should include message count");
  });

  test("setMemory updates the memory reference", async () => {
    const inner1 = new SimpleMemory();
    await inner1.add(msg("user", "first"));

    const inner2 = new SimpleMemory();
    await inner2.add(msg("user", "second"));
    await inner2.add(msg("user", "third"));

    const source = new ContextMapSource(inner1);
    let output = await source.poll();
    assert.ok(output!.includes("1 msgs"));

    source.setMemory(inner2);
    output = await source.poll();
    assert.ok(output!.includes("2 msgs"));
  });

  test("drill-down filter renders page detail", async () => {
    const now = new Date();
    const inner = new SimpleMemory();
    (inner as any).getStats = () => virtualStats({
      pageDigest: [
        { id: "pg_target", label: "target page", tokens: 1200, loaded: true, pinned: false, summary: "Detailed discussion about authentication flow", createdAt: now.toISOString(), messageCount: 8, maxImportance: 0.7, lane: "assistant" },
        { id: "pg_other", label: "other page", tokens: 600, loaded: false, pinned: false, summary: "Other content", createdAt: now.toISOString(), messageCount: 3, maxImportance: 0.2, lane: "user" },
      ],
    });

    const source = new ContextMapSource(inner);

    // Set drill-down filter to a specific page
    source.setFilter("pg_target");
    const output = await source.poll();

    assert.ok(output);
    assert.ok(output!.includes("pg_target"), "should show target page ID");
    assert.ok(output!.includes("page detail"), "should indicate drill-down mode");
    assert.ok(output!.includes("1.2k") || output!.includes("1200"), "should show token count");
    assert.ok(output!.includes("assistant"), "should show lane");

    // Filter should be consumed (one-shot)
    const output2 = await source.poll();
    assert.ok(output2);
    assert.ok(output2!.includes("PAGES"), "should return to normal view after filter consumed");
  });

  test("load budget section shows slot usage", async () => {
    const inner = new SimpleMemory();
    (inner as any).getStats = () => virtualStats({
      pageSlotBudget: 18000,
      pageSlotUsed: 6000,
    });

    const source = new ContextMapSource(inner);
    const output = await source.poll();

    assert.ok(output);
    assert.ok(output!.includes("LOAD BUDGET"), "should have load budget section");
    assert.ok(output!.includes("slots:"), "should show slots label");
    assert.ok(output!.includes("used"), "should show used indicator");
    assert.ok(output!.includes("budget"), "should show budget indicator");
  });

  test("page rows show loaded/unloaded/pinned status", async () => {
    const now = new Date();
    const inner = new SimpleMemory();
    (inner as any).getStats = () => virtualStats({
      pagesLoaded: 2,
      pageDigest: [
        { id: "pg_live", label: "live", tokens: 500, loaded: true, pinned: false, summary: "Live page", createdAt: now.toISOString(), messageCount: 3, maxImportance: 0, lane: "assistant" },
        { id: "pg_pinned", label: "pinned", tokens: 300, loaded: true, pinned: true, summary: "Pinned page", createdAt: now.toISOString(), messageCount: 2, maxImportance: 0, lane: "system" },
        { id: "pg_dark", label: "dark", tokens: 200, loaded: false, pinned: false, summary: "Dark page", createdAt: now.toISOString(), messageCount: 1, maxImportance: 0, lane: "user" },
      ],
    });

    const source = new ContextMapSource(inner);
    const output = await source.poll();

    assert.ok(output);
    // Status indicators
    assert.ok(output!.includes("live"), "should show live status for loaded pages");
    assert.ok(output!.includes("dark"), "should show dark status for unloaded pages");
    assert.ok(output!.includes("pin"), "should show pin status for pinned pages");
  });

  test("empty page digest renders gracefully", async () => {
    const inner = new SimpleMemory();
    (inner as any).getStats = () => virtualStats({
      pageDigest: [],
      pagesLoaded: 0,
      pagesAvailable: 0,
    });

    const source = new ContextMapSource(inner);
    const output = await source.poll();

    assert.ok(output);
    assert.ok(output!.includes("PAGES"), "should have PAGES header");
    assert.ok(output!.includes("0 total"), "should show 0 total pages");
    assert.ok(output!.includes("no pages"), "should show no pages indicator");
    assert.ok(output!.includes("SIZE HISTOGRAM"), "should still have histogram");
    assert.ok(output!.includes("LOAD BUDGET"), "should still have load budget");
  });
});

describe("SensoryMemory + ContextMapSource integration", () => {
  test("full pipeline: wrap, poll, render, inject", async () => {
    const inner = new SimpleMemory("You are a helpful assistant.");
    await inner.add(msg("user", "What is 2+2?"));
    await inner.add(msg("assistant", "4"));

    const sensory = new SensoryMemory(inner, { totalBudget: 500 });
    const contextMap = new ContextMapSource(inner);

    sensory.addChannel({
      name: "context",
      maxTokens: 300,
      updateMode: "every_turn",
      content: "",
      enabled: true,
      source: contextMap,
    });

    // Poll to fill the channel
    await sensory.pollSources();

    // Check messages
    const msgs = sensory.messages();
    assert.strictEqual(msgs[0].role, "system");
    assert.strictEqual(msgs[0].content, "You are a helpful assistant.");
    assert.strictEqual(msgs[1].role, "system");
    assert.ok(msgs[1].content.includes("SENSORY BUFFER"));
    assert.ok(msgs[1].content.includes("MEMORY")); // basic render for SimpleMemory
    assert.strictEqual(msgs[2].content, "What is 2+2?");
    assert.strictEqual(msgs[3].content, "4");
  });
});

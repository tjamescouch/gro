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

  test("per-channel token budget truncates content", () => {
    const inner = new SimpleMemory();
    const sensory = new SensoryMemory(inner, { avgCharsPerToken: 1 });

    sensory.addChannel({
      name: "limited",
      maxTokens: 10, // ~10 chars at 1 char/tok
      updateMode: "manual",
      content: "",
      enabled: true,
    });

    // Push content exceeding budget
    const longContent = "A".repeat(100);
    sensory.update("limited", longContent);

    const msgs = sensory.messages();
    // Even though the message is injected, the content should be truncated
    const sensoryMsg = msgs[0]; // no system prompt
    assert.ok(sensoryMsg.content.includes("SENSORY BUFFER"));
    // The channel content should be truncated to ~10 chars + "..."
    assert.ok(sensoryMsg.content.length < longContent.length + 100);
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
  test("renders basic stats for SimpleMemory", async () => {
    const inner = new SimpleMemory();
    await inner.add(msg("user", "hello world"));
    await inner.add(msg("assistant", "hi there"));

    const source = new ContextMapSource(inner);
    const output = await source.poll();

    assert.ok(output);
    // Spatial basic: used row + free row + stats line
    assert.ok(output!.includes("used"));
    assert.ok(output!.includes("free"));
    assert.ok(/[▒░]/.test(output!));
    assert.ok(output!.includes("simple"));
    assert.ok(output!.includes("msgs"));
    assert.ok(output!.includes("tok"));
  });

  test("renders virtual stats with spatial 2D rows", async () => {
    // Create a mock that returns VirtualMemoryStats
    const inner = new SimpleMemory();
    // Override getStats to simulate VirtualMemory
    (inner as any).getStats = () => ({
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
    });

    const source = new ContextMapSource(inner, { barWidth: 32 });
    const output = await source.poll();

    assert.ok(output);
    // Spatial rows: each region gets its own row with fill chars
    assert.ok(/[█▓▒░]/.test(output!));
    // Should have sys row (█), page row (▓), lane rows (▒), free row (░)
    assert.ok(output!.includes("█"), "should have sys row with █");
    assert.ok(output!.includes("▓"), "should have page row with ▓");
    assert.ok(output!.includes("▒"), "should have lane rows with ▒");
    // Should contain lane labels
    assert.ok(output!.includes(" ast "), "should have assistant lane row");
    assert.ok(output!.includes(" usr "), "should have user lane row");
    assert.ok(output!.includes("tool "), "should have tool lane row");
    // Should contain free row
    assert.ok(output!.includes("free"), "should have free row");
    // Should contain stats line
    assert.ok(output!.includes("K/"), "should have used/budget stats");
    assert.ok(output!.includes("pg:2/5"));
    assert.ok(output!.includes("sonnet"));
  });

  test("render stays under 300 tokens", async () => {
    const inner = new SimpleMemory();
    (inner as any).getStats = () => ({
      type: "virtual",
      totalMessages: 100,
      totalTokensEstimate: 25000,
      bufferMessages: 100,
      systemTokens: 2800,
      workingMemoryBudget: 32000,
      workingMemoryUsed: 25000,
      pageSlotBudget: 16000,
      pageSlotUsed: 4800,
      pagesAvailable: 14,
      pagesLoaded: 3,
      highRatio: 0.75,
      compactionActive: true,
      thinkingBudget: 0.8,
      lanes: [
        { role: "assistant", tokens: 11000, count: 30 },
        { role: "user", tokens: 6000, count: 25 },
        { role: "tool", tokens: 5000, count: 20 },
        { role: "system", tokens: 2800, count: 10 },
      ],
      pinnedMessages: 3,
      model: "claude-opus-4-5-20250514",
    });

    const source = new ContextMapSource(inner, { barWidth: 32 });
    const output = await source.poll();

    assert.ok(output);
    // Rough token estimate: chars / 2.8
    const estimatedTokens = output!.length / 2.8;
    assert.ok(estimatedTokens < 300, `Render too long: ~${Math.round(estimatedTokens)} tokens (${output!.length} chars)`);
  });

  test("LOW indicator when free < 20%", async () => {
    const inner = new SimpleMemory();
    (inner as any).getStats = () => ({
      type: "virtual",
      totalMessages: 50,
      totalTokensEstimate: 18000,
      bufferMessages: 50,
      systemTokens: 2000,
      workingMemoryBudget: 12000,
      workingMemoryUsed: 11000,
      pageSlotBudget: 8000,
      pageSlotUsed: 6000,
      pagesAvailable: 5,
      pagesLoaded: 3,
      highRatio: 0.75,
      compactionActive: false,
      thinkingBudget: 0.5,
      lanes: [
        { role: "assistant", tokens: 6000, count: 20 },
        { role: "user", tokens: 5000, count: 15 },
      ],
      pinnedMessages: 0,
      model: "sonnet",
    });

    const source = new ContextMapSource(inner, { barWidth: 32 });
    const output = await source.poll();

    assert.ok(output);
    // free = 20000 - 2000 - 6000 - 11000 = 1000, freePct = 1000/20000 = 5% → LOW
    assert.ok(output!.includes("← LOW"), "should show LOW indicator when free < 20%");
  });

  test("no LOW indicator when free is abundant", async () => {
    const inner = new SimpleMemory();
    (inner as any).getStats = () => ({
      type: "virtual",
      totalMessages: 10,
      totalTokensEstimate: 3000,
      bufferMessages: 10,
      systemTokens: 500,
      workingMemoryBudget: 8000,
      workingMemoryUsed: 2000,
      pageSlotBudget: 6000,
      pageSlotUsed: 0,
      pagesAvailable: 2,
      pagesLoaded: 0,
      highRatio: 0.75,
      compactionActive: false,
      thinkingBudget: null,
      lanes: [
        { role: "assistant", tokens: 1000, count: 5 },
        { role: "user", tokens: 1000, count: 5 },
      ],
      pinnedMessages: 0,
      model: "haiku",
    });

    const source = new ContextMapSource(inner, { barWidth: 32 });
    const output = await source.poll();

    assert.ok(output);
    // free = 14000 - 500 - 0 - 2000 = 11500, freePct = 82% → no LOW
    assert.ok(!output!.includes("← LOW"), "should not show LOW when free > 20%");
  });

  test("graceful degradation for basic memory types", async () => {
    const inner = new SimpleMemory();
    await inner.add(msg("user", "hello"));

    const source = new ContextMapSource(inner);
    const output = await source.poll();

    // Should render without error
    assert.ok(output);
    assert.ok(output!.includes("simple"));
    assert.ok(output!.includes("used"));
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

  test("showLanes=false omits individual lane rows", async () => {
    const inner = new SimpleMemory();
    (inner as any).getStats = () => ({
      type: "virtual",
      totalMessages: 10,
      totalTokensEstimate: 3000,
      bufferMessages: 10,
      systemTokens: 200,
      workingMemoryBudget: 8000,
      workingMemoryUsed: 3000,
      pageSlotBudget: 4000,
      pageSlotUsed: 1200,
      pagesAvailable: 2,
      pagesLoaded: 1,
      highRatio: 0.75,
      compactionActive: false,
      thinkingBudget: null,
      lanes: [
        { role: "assistant", tokens: 1500, count: 5 },
        { role: "user", tokens: 1500, count: 5 },
      ],
      pinnedMessages: 0,
      model: "haiku",
    });

    const source = new ContextMapSource(inner, { showLanes: false });
    const output = await source.poll();

    assert.ok(output);
    // Should NOT contain lane row labels
    assert.ok(!output!.includes(" ast "), "should not show ast lane row");
    assert.ok(!output!.includes(" usr "), "should not show usr lane row");
    // Should still contain sys, free, and stats
    assert.ok(output!.includes(" sys ") || output!.includes("█"), "should still show sys row");
    assert.ok(output!.includes("free"), "should still show free row");
    assert.ok(output!.includes("pg:"), "should still show stats line");
  });

  test("LOW indicator when compaction is active", async () => {
    const inner = new SimpleMemory();
    (inner as any).getStats = () => ({
      type: "virtual",
      totalMessages: 30,
      totalTokensEstimate: 10000,
      bufferMessages: 30,
      systemTokens: 1000,
      workingMemoryBudget: 16000,
      workingMemoryUsed: 5000,
      pageSlotBudget: 8000,
      pageSlotUsed: 2000,
      pagesAvailable: 5,
      pagesLoaded: 2,
      highRatio: 0.75,
      compactionActive: true,
      thinkingBudget: 0.5,
      lanes: [
        { role: "assistant", tokens: 3000, count: 15 },
        { role: "user", tokens: 2000, count: 10 },
      ],
      pinnedMessages: 0,
      model: "sonnet",
    });

    const source = new ContextMapSource(inner, { barWidth: 32 });
    const output = await source.poll();

    assert.ok(output);
    // free = 24000 - 1000 - 2000 - 5000 = 16000, freePct = 66% > 20%
    // But compactionActive is true → should still show LOW
    assert.ok(output!.includes("← LOW"), "should show LOW when compaction is active");
  });
});

describe("SensoryMemory + ContextMapSource integration", () => {
  test("full pipeline: wrap, poll, render, inject", async () => {
    const inner = new SimpleMemory("You are a helpful assistant.");
    await inner.add(msg("user", "What is 2+2?"));
    await inner.add(msg("assistant", "4"));

    const sensory = new SensoryMemory(inner, { totalBudget: 500 });
    const contextMap = new ContextMapSource(inner, { barWidth: 16 });

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
    assert.ok(msgs[1].content.includes("simple")); // basic render for SimpleMemory
    assert.strictEqual(msgs[2].content, "What is 2+2?");
    assert.strictEqual(msgs[3].content, "4");
  });
});

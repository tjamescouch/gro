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

    // Disable specific channel
    sensory.onSenseMarker("off", "ctx");
    let msgs = sensory.messages();
    assert.ok(!msgs.some(m => m.content?.includes("SENSORY BUFFER")));

    // Re-enable
    sensory.onSenseMarker("on", "ctx");
    msgs = sensory.messages();
    assert.ok(msgs.some(m => m.content?.includes("context data")));
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
    assert.ok(output!.includes("simple"));
    assert.ok(output!.includes("msgs"));
    assert.ok(output!.includes("tok"));
  });

  test("renders virtual stats with bar chart", async () => {
    // Create a mock that returns VirtualMemoryStats
    const inner = new SimpleMemory();
    // Override getStats to simulate VirtualMemory
    (inner as any).getStats = () => ({
      type: "virtual",
      totalMessages: 20,
      totalTokensEstimate: 5000,
      bufferMessages: 20,
      workingMemoryBudget: 8000,
      workingMemoryUsed: 4000,
      pageSlotBudget: 6000,
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
    // Should contain bar chart characters
    assert.ok(/[█▓▒░]/.test(output!));
    // Should contain token stats
    assert.ok(output!.includes("K"));
    assert.ok(output!.includes("tok"));
    // Should contain lane breakdown
    assert.ok(output!.includes("ass:"));
    assert.ok(output!.includes("use:"));
    // Should contain page stats
    assert.ok(output!.includes("pg:2/5"));
    // Should contain model
    assert.ok(output!.includes("sonnet"));
  });

  test("render stays under 300 tokens", async () => {
    const inner = new SimpleMemory();
    (inner as any).getStats = () => ({
      type: "virtual",
      totalMessages: 100,
      totalTokensEstimate: 25000,
      bufferMessages: 100,
      workingMemoryBudget: 32000,
      workingMemoryUsed: 25000,
      pageSlotBudget: 16000,
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

  test("graceful degradation for basic memory types", async () => {
    const inner = new SimpleMemory();
    await inner.add(msg("user", "hello"));

    const source = new ContextMapSource(inner);
    const output = await source.poll();

    // Should render without error
    assert.ok(output);
    assert.ok(output!.includes("simple"));
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

  test("showLanes=false omits lane breakdown", async () => {
    const inner = new SimpleMemory();
    (inner as any).getStats = () => ({
      type: "virtual",
      totalMessages: 10,
      totalTokensEstimate: 3000,
      bufferMessages: 10,
      workingMemoryBudget: 8000,
      workingMemoryUsed: 3000,
      pageSlotBudget: 4000,
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
    assert.ok(!output!.includes("wm: ass:"));
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

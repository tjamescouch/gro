/**
 * Tests for AgentMemory, SimpleMemory, and AdvancedMemory.
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import type { ChatDriver, ChatMessage, ChatOutput } from "../src/drivers/types.js";
import { SimpleMemory } from "../src/memory/simple-memory.js";
import { AdvancedMemory } from "../src/memory/advanced-memory.js";

/** Mock driver that returns a canned summary. */
function mockDriver(response = "Summary bullet point."): ChatDriver {
  return {
    async chat(_msgs: ChatMessage[], _opts?: any): Promise<ChatOutput> {
      return { text: response, toolCalls: [] };
    },
  };
}

/** Helper to build a message. */
function msg(role: string, content: string, from?: string): ChatMessage {
  return { role, content, from: from ?? role };
}

describe("SimpleMemory", () => {
  test("stores messages in order", async () => {
    const mem = new SimpleMemory();
    await mem.add(msg("user", "hello"));
    await mem.add(msg("assistant", "hi"));
    const msgs = mem.messages();
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].content, "hello");
    assert.strictEqual(msgs[1].content, "hi");
  });

  test("prepends system prompt", async () => {
    const mem = new SimpleMemory("You are helpful.");
    await mem.add(msg("user", "hello"));
    const msgs = mem.messages();
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].role, "system");
    assert.strictEqual(msgs[0].content, "You are helpful.");
    assert.strictEqual(msgs[1].content, "hello");
  });

  test("empty system prompt is not added", async () => {
    const mem = new SimpleMemory("   ");
    const msgs = mem.messages();
    assert.strictEqual(msgs.length, 0);
  });

  test("addIfNotExists deduplicates", async () => {
    const mem = new SimpleMemory();
    await mem.add(msg("user", "hello"));
    await mem.addIfNotExists(msg("user", "hello"));
    await mem.addIfNotExists(msg("user", "world"));
    const msgs = mem.messages();
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[1].content, "world");
  });

  test("messages() returns a copy", async () => {
    const mem = new SimpleMemory();
    await mem.add(msg("user", "hello"));
    const msgs = mem.messages();
    msgs.push(msg("user", "injected"));
    assert.strictEqual(mem.messages().length, 1);
  });

  test("load and save are no-ops", async () => {
    const mem = new SimpleMemory();
    await mem.load("test-id");
    await mem.save("test-id");
    // No error thrown
  });
});

describe("AdvancedMemory", () => {
  test("stores messages when under budget", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver(),
      model: "test-model",
      contextTokens: 100_000,
    });
    await mem.add(msg("user", "hello"));
    await mem.add(msg("assistant", "hi"));
    const msgs = mem.messages();
    assert.strictEqual(msgs.length, 2);
  });

  test("includes system prompt", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver(),
      model: "test-model",
      systemPrompt: "Be helpful.",
    });
    await mem.add(msg("user", "hello"));
    const msgs = mem.messages();
    assert.strictEqual(msgs[0].role, "system");
    assert.strictEqual(msgs[0].content, "Be helpful.");
  });

  test("triggers compaction when budget exceeded", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver(),
      model: "test-model",
      contextTokens: 4096,
      reserveHeaderTokens: 200,
      reserveResponseTokens: 200,
      avgCharsPerToken: 4,
      highRatio: 0.70,
      lowRatio: 0.50,
      keepRecentPerLane: 2,
    });

    // Add enough messages to exceed the high watermark.
    // Budget = 3696 tokens. High = 2587 tokens = ~10348 chars.
    // Each msg pair ~200 chars + 64 overhead = ~264 chars.
    // Need ~40 pairs to exceed.
    for (let i = 0; i < 60; i++) {
      await mem.add(msg("user", `Message number ${i} with padding text to use up token budget quickly.`));
      await mem.add(msg("assistant", `Reply number ${i} acknowledging the user's message with detail.`));
    }

    // After compaction (summarization or pruning), buffer should be smaller
    const msgs = mem.messages();
    assert.ok(msgs.length < 120, `Expected compaction to reduce messages, got ${msgs.length}`);
    // Should still have some messages (not empty)
    assert.ok(msgs.length > 0, "Buffer should not be empty after compaction");
  });

  test("preserves system prompt during summarization", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver(),
      model: "test-model",
      systemPrompt: "Critical instruction.",
      contextTokens: 2048,
      avgCharsPerToken: 4,
      keepRecentPerLane: 1,
    });

    for (let i = 0; i < 30; i++) {
      await mem.add(msg("user", `User msg ${i} with padding to fill the budget up.`));
      await mem.add(msg("assistant", `Assistant reply ${i} also with padding text.`));
    }

    const msgs = mem.messages();
    const systemMsgs = msgs.filter(m => m.role === "system");
    assert.ok(systemMsgs.length > 0, "System messages should be preserved after summarization");
  });

  test("handles tool messages", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver(),
      model: "test-model",
      contextTokens: 100_000,
      keepRecentTools: 2,
    });

    await mem.add(msg("user", "Run the tool"));
    await mem.add({ role: "tool", content: "tool result 1", from: "tool", tool_call_id: "tc1" });
    await mem.add({ role: "tool", content: "tool result 2", from: "tool", tool_call_id: "tc2" });
    await mem.add(msg("assistant", "Got it"));

    const msgs = mem.messages();
    const toolMsgs = msgs.filter(m => m.role === "tool");
    assert.strictEqual(toolMsgs.length, 2);
  });

  test("config clamps extreme values", async () => {
    // This shouldn't throw — extreme values get clamped
    const mem = new AdvancedMemory({
      driver: mockDriver(),
      model: "test-model",
      contextTokens: 100,       // gets clamped to 2048
      highRatio: 99,             // clamped to 0.95
      lowRatio: -5,              // clamped to 0.35
      summaryRatio: 999,         // clamped to 0.50
      avgCharsPerToken: 0.1,     // clamped to 1.5
      keepRecentPerLane: -1,     // clamped to 1
      keepRecentTools: -10,      // clamped to 0
    });
    await mem.add(msg("user", "still works"));
    assert.strictEqual(mem.messages().length, 1);
  });
});

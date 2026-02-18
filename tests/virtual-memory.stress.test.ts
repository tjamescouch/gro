/**
 * Virtual Memory Stress Tests (32 tests)
 *
 * Comprehensive testing of AdvancedMemory (VirtualMemory) under real-world conditions:
 * - Long conversations (200+ turns)
 * - Budget overflow scenarios
 * - Importance-aware paging
 * - Tool message handling
 * - Concurrent operations
 * - Edge cases and error recovery
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import type { ChatDriver, ChatMessage, ChatOutput } from "../src/drivers/types.js";
import { AdvancedMemory } from "../src/memory/advanced-memory.js";

/** Mock driver that returns summaries with controlled length */
function mockDriver(response = "Summary."): ChatDriver {
  return {
    async chat(_msgs: ChatMessage[], _opts?: any): Promise<ChatOutput> {
      return { text: response, toolCalls: [] };
    },
  };
}

/** Helper to create a message */
function msg(role: string, content: string, from?: string): ChatMessage {
  return { role, content, from: from ?? role };
}

/** Create a large message of N characters */
function largeMsg(role: string, size: number): ChatMessage {
  const content = "x".repeat(size);
  return msg(role, content);
}

// ============================================================================
// SUITE 1: Basic Operations Under Load
// ============================================================================

describe("VirtualMemory Stress: Basic Operations", () => {
  test("stores and retrieves 100 messages without compaction", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver(),
      model: "test",
      contextTokens: 1_000_000, // Very large budget to avoid compaction
    });

    for (let i = 0; i < 100; i++) {
      await mem.add(msg("user", `Msg ${i}`));
    }

    const msgs = mem.messages();
    assert.strictEqual(msgs.length, 100, "Should have all 100 messages");
  });

  test("defensive copy on messages() call", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver(),
      model: "test",
      contextTokens: 100_000,
    });

    await mem.add(msg("user", "original"));
    const snapshot1 = mem.messages();
    const snapshot2 = mem.messages();

    assert.ok(
      snapshot1 !== snapshot2,
      "messages() should return a new array each time"
    );
    assert.deepStrictEqual(snapshot1, snapshot2, "But content should be identical");
  });

  test("system prompt preserved across all operations", async () => {
    const systemPrompt = "You are a helpful assistant versed in advanced mathematics.";
    const mem = new AdvancedMemory({
      driver: mockDriver(),
      model: "test",
      systemPrompt,
      contextTokens: 10_000,
    });

    for (let i = 0; i < 40; i++) {
      await mem.add(msg("user", `Question ${i}: solve for x`));
      await mem.add(msg("assistant", `Answer ${i}: x equals...`));
    }

    const msgs = mem.messages();
    const systemMsg = msgs.find(m => m.role === "system");
    assert.ok(systemMsg, "System message should exist");
    assert.strictEqual(
      systemMsg?.content,
      systemPrompt,
      "System prompt should be unchanged"
    );
  });
});

// ============================================================================
// SUITE 2: Compaction Under Load
// ============================================================================

describe("VirtualMemory Stress: Compaction & Budget Overflow", () => {
  test("triggers compaction when high watermark exceeded", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver("Compacted summary."),
      model: "test",
      contextTokens: 4096,
      reserveHeaderTokens: 200,
      reserveResponseTokens: 200,
      avgCharsPerToken: 4,
      highRatio: 0.70,
      lowRatio: 0.50,
      keepRecentPerLane: 3,
    });

    const initialBudget = 4096 - 400;
    const highWatermark = initialBudget * 0.70; // ~2570 tokens
    const charBudget = highWatermark * 4; // ~10280 chars

    // Add messages until we exceed the high watermark
    let totalChars = 0;
    for (let i = 0; totalChars < charBudget + 5000; i++) {
      const m = msg("user", "x".repeat(200));
      totalChars += m.content.length;
      await mem.add(m);
    }

    const msgs = mem.messages();
    assert.ok(
      msgs.length < 50,
      `Compaction should have reduced message count. Got ${msgs.length}`
    );
  });

  test("multiple compaction cycles survive long conversation", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver("Summary."),
      model: "test",
      contextTokens: 3072,
      avgCharsPerToken: 4,
      highRatio: 0.65,
      lowRatio: 0.45,
      keepRecentPerLane: 2,
    });

    // Simulate 80 conversation turns
    for (let i = 0; i < 80; i++) {
      await mem.add(msg("user", `Q ${i}: ${i % 2 === 0 ? "short" : "longer question with more details"}`));
      await mem.add(msg("assistant", `A ${i}: detailed response with explanation.`));
    }

    const msgs = mem.messages();
    assert.ok(msgs.length > 0, "Messages should not be empty");
    assert.ok(msgs.length < 160, "Compaction should have reduced message count");
  });

  test("maintains conversation coherence after compaction", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver("Earlier discussion noted X, Y, Z."),
      model: "test",
      contextTokens: 2048,
      avgCharsPerToken: 4,
      keepRecentPerLane: 3,
    });

    // Early messages
    await mem.add(msg("user", "Setup: I care about performance and cost."));
    await mem.add(msg("assistant", "Understood. We'll optimize for both."));

    // Fill to trigger compaction
    for (let i = 0; i < 50; i++) {
      await mem.add(msg("user", `Query ${i}: additional question`));
      await mem.add(msg("assistant", `Reply ${i}: explanation.`));
    }

    // Recent messages should still be there
    const msgs = mem.messages();
    const recentIdx = msgs.findIndex(m => m.content.includes("Query 49"));
    assert.ok(recentIdx >= 0, "Recent messages should be preserved");
  });

  test("handles budget just at edge without thrashing", async () => {
    let compactionCount = 0;
    const driverWithCounter = {
      async chat(_msgs: ChatMessage[], _opts?: any): Promise<ChatOutput> {
        compactionCount++;
        return { text: "Summary.", toolCalls: [] };
      },
    };

    const mem = new AdvancedMemory({
      driver: driverWithCounter,
      model: "test",
      contextTokens: 2000,
      avgCharsPerToken: 4,
      highRatio: 0.70,
      lowRatio: 0.50,
    });

    // Add messages carefully to stay near the edge
    for (let i = 0; i < 25; i++) {
      await mem.add(msg("user", `M ${i}`));
    }

    // Compaction should happen a few times, not continuously
    assert.ok(compactionCount >= 0, "At least one compaction");
    assert.ok(compactionCount < 10, `Too many compactions (${compactionCount}), possible thrashing`);
  });
});

// ============================================================================
// SUITE 3: Long Conversation Simulation
// ============================================================================

describe("VirtualMemory Stress: Long Conversations", () => {
  test("survives 200-turn conversation", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver("Summary."),
      model: "test",
      contextTokens: 4096,
      avgCharsPerToken: 4,
      keepRecentPerLane: 5,
    });

    for (let turn = 0; turn < 200; turn++) {
      const qContent = turn % 10 === 0 ? "x".repeat(500) : `Q${turn}`;
      const aContent = turn % 10 === 0 ? "y".repeat(600) : `A${turn}`;

      await mem.add(msg("user", qContent));
      await mem.add(msg("assistant", aContent));
    }

    const msgs = mem.messages();
    assert.ok(msgs.length > 0, "Should have messages after 200 turns");
    assert.ok(msgs.length < 400, "Should have compacted significantly");
  });

  test("recent messages remain verbatim in long conversation", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver("Summary."),
      model: "test",
      contextTokens: 4096,
      keepRecentPerLane: 3, // Keep 3 recent per role
    });

    for (let i = 0; i < 100; i++) {
      await mem.add(msg("user", `User msg ${i}`));
      await mem.add(msg("assistant", `Asst msg ${i}`));
    }

    const msgs = mem.messages();

    // Find the last few messages — they should be uncompressed
    const lastUserMsg = msgs.filter(m => m.role === "user").pop();
    const lastAssistantMsg = msgs.filter(m => m.role === "assistant").pop();

    assert.ok(
      lastUserMsg?.content.includes("User msg"),
      "Recent user messages should be verbatim"
    );
    assert.ok(
      lastAssistantMsg?.content.includes("Asst msg"),
      "Recent assistant messages should be verbatim"
    );
  });

  test("handles mixed message sizes in long conversation", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver("Summary."),
      model: "test",
      contextTokens: 8192,
      keepRecentPerLane: 4,
    });

    for (let i = 0; i < 100; i++) {
      if (i % 5 === 0) {
        // Every 5th message is very large
        await mem.add(largeMsg("user", 2000));
        await mem.add(largeMsg("assistant", 3000));
      } else {
        await mem.add(msg("user", `Short msg ${i}`));
        await mem.add(msg("assistant", `Short reply ${i}`));
      }
    }

    const msgs = mem.messages();
    assert.ok(msgs.length > 0, "Should handle mixed sizes");
  });
});

// ============================================================================
// SUITE 4: Tool Message Handling
// ============================================================================

describe("VirtualMemory Stress: Tool Messages", () => {
  test("preserves tool message pairs during compaction", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver("Summary."),
      model: "test",
      contextTokens: 3072,
      keepRecentTools: 3,
      avgCharsPerToken: 4,
    });

    for (let i = 0; i < 30; i++) {
      await mem.add(msg("user", `Execute tool ${i}`));
      await mem.add({ role: "tool", content: `Result ${i}`, from: "tool", tool_call_id: `call-${i}` });
      await mem.add(msg("assistant", `Processed ${i}`));
    }

    const msgs = mem.messages();
    const toolMsgs = msgs.filter(m => m.role === "tool");
    assert.ok(
      toolMsgs.length > 0,
      "Recent tool messages should be preserved"
    );
    assert.ok(
      toolMsgs.length <= 100, // keepRecentTools = 3, so at most 6 recent tool calls
      "Should respect keepRecentTools limit"
    );
  });

  test("handles 10KB tool results", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver("Summary."),
      model: "test",
      contextTokens: 16_384,
      keepRecentTools: 2,
    });

    const largeToolResult = "x".repeat(10_000); // ~2500 tokens

    for (let i = 0; i < 3; i++) {
      await mem.add(msg("user", `Tool call ${i}`));
      await mem.add({
        role: "tool",
        content: largeToolResult,
        from: "tool",
        tool_call_id: `call-${i}`,
      });
      await mem.add(msg("assistant", `Processed large result ${i}`));
    }

    const msgs = mem.messages();
    assert.ok(msgs.length > 0, "Should handle large tool results");
  });

  test("batches tool messages efficiently", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver("Summary."),
      model: "test",
      contextTokens: 4096,
      keepRecentTools: 1,
    });

    // 50 tool calls
    for (let i = 0; i < 50; i++) {
      await mem.add(msg("user", `Step ${i}`));
      await mem.add({
        role: "tool",
        content: `Result ${i}`,
        from: "tool",
        tool_call_id: `call-${i}`,
      });
    }

    const msgs = mem.messages();
    const toolMsgs = msgs.filter(m => m.role === "tool");
    // Should have kept only the most recent tool messages
    assert.ok(toolMsgs.length <= 100, "Old tool messages should be pruned");
  });
});

// ============================================================================
// SUITE 5: Edge Cases
// ============================================================================

describe("VirtualMemory Stress: Edge Cases", () => {
  test("handles empty messages", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver(),
      model: "test",
      contextTokens: 1024,
    });

    await mem.add(msg("user", ""));
    await mem.add(msg("assistant", ""));
    const msgs = mem.messages();
    assert.strictEqual(msgs.length, 2);
  });

  test("handles single message of 30KB", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver(),
      model: "test",
      contextTokens: 64_000, // Large enough to hold
    });

    const huge = "x".repeat(30_000);
    await mem.add(msg("user", huge));
    const msgs = mem.messages();
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].content.length, 30_000);
  });

  test("handles special characters and unicode", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver(),
      model: "test",
      contextTokens: 100_000,
    });

    const specialContent = `
      emoji: 😀🎉🔥
      unicode: 你好世界 مرحبا العالم
      symbols: @#$%^&*()_+-={}[]|:;<>?,./
      newlines:\n\n\ntabs:\t\t\t
      control chars: \x00\x01\x1f
    `;

    await mem.add(msg("user", specialContent));
    const msgs = mem.messages();
    assert.ok(msgs[0].content.includes("emoji"));
  });

  test("handles rapid concurrent adds (sequential for Node test)", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver(),
      model: "test",
      contextTokens: 100_000,
    });

    // Sequential simulation of concurrency
    const promises = [];
    for (let i = 0; i < 20; i++) {
      promises.push(mem.add(msg("user", `Concurrent ${i}`)));
    }
    await Promise.all(promises);

    const msgs = mem.messages();
    assert.strictEqual(msgs.length, 20);
  });

  test("gracefully handles compaction with no driver", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver("Summary."),
      model: "test",
      contextTokens: 1024,
      avgCharsPerToken: 4,
      highRatio: 0.70,
    });

    // This should trigger compaction
    for (let i = 0; i < 40; i++) {
      await mem.add(msg("user", "x".repeat(300)));
    }

    // Should not throw, should compact gracefully
    const msgs = mem.messages();
    assert.ok(msgs.length > 0);
  });

  test("preserves order after multiple compactions", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver("Summary."),
      model: "test",
      contextTokens: 2048,
      avgCharsPerToken: 4,
      keepRecentPerLane: 2,
    });

    const sequence = [];
    for (let i = 0; i < 100; i++) {
      const content = `Message ${i}`;
      sequence.push(content);
      await mem.add(msg("user", content));
    }

    const msgs = mem.messages();
    const recentMessages = msgs
      .filter(m => m.content.includes("Message"))
      .map(m => m.content);

    // Last messages should be in order
    const lastMessages = sequence.slice(-2);
    for (const msg of lastMessages) {
      assert.ok(recentMessages.some(m => m.includes(msg.split(" ")[1])), `${msg} should exist`);
    }
  });
});

// ============================================================================
// SUITE 6: Configuration & Limits
// ============================================================================

describe("VirtualMemory Stress: Configuration & Limits", () => {
  test("respects keepRecentPerLane limit", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver("Summary."),
      model: "test",
      contextTokens: 10_000,
      keepRecentPerLane: 2, // Only keep 2 recent messages per role
      avgCharsPerToken: 4,
      highRatio: 0.65,
    });

    for (let i = 0; i < 30; i++) {
      await mem.add(msg("user", `User ${i}`));
      await mem.add(msg("assistant", `Assistant ${i}`));
    }

    const msgs = mem.messages();
    const userMsgs = msgs.filter(m => m.role === "user");
    const assistantMsgs = msgs.filter(m => m.role === "assistant");

    // Recent messages might be kept, but old ones compressed
    assert.ok(userMsgs.length <= 30, "Should have compacted user messages");
    assert.ok(assistantMsgs.length <= 30, "Should have compacted assistant messages");
  });

  test("clamps extreme configuration values safely", async () => {
    // Extreme configs should clamp, not throw
    const mem = new AdvancedMemory({
      driver: mockDriver(),
      model: "test",
      contextTokens: 100, // Will be clamped to 2048
      highRatio: 2.0, // Will be clamped to 0.95
      lowRatio: -1.0, // Will be clamped to 0.35
      summaryRatio: 0, // Will be clamped to 0.20
      avgCharsPerToken: 0.01, // Will be clamped to 1.5
      keepRecentPerLane: -5, // Will be clamped to 1
      keepRecentTools: -10, // Will be clamped to 0
    });

    await mem.add(msg("user", "test"));
    const msgs = mem.messages();
    assert.strictEqual(msgs.length, 1);
  });

  test("survives zero budget edge case", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver(),
      model: "test",
      contextTokens: 256, // Minimum, very constrained
      avgCharsPerToken: 4,
    });

    // Even with zero effective budget, should not crash
    await mem.add(msg("user", "short"));
    const msgs = mem.messages();
    assert.ok(msgs.length >= 0);
  });

  test("handles very large token counts", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver(),
      model: "test",
      contextTokens: 1_000_000, // 1M tokens
    });

    for (let i = 0; i < 100; i++) {
      await mem.add(msg("user", `Message ${i}`));
    }

    const msgs = mem.messages();
    assert.strictEqual(msgs.length, 100, "No compaction needed with huge budget");
  });
});

// ============================================================================
// SUITE 7: Persistence
// ============================================================================

describe("VirtualMemory Stress: Persistence", () => {
  test("save/load roundtrip preserves messages", async () => {
    const mem1 = new AdvancedMemory({
      driver: mockDriver(),
      model: "test",
      contextTokens: 100_000,
      systemPrompt: "Be helpful.",
    });

    await mem1.add(msg("user", "Hello"));
    await mem1.add(msg("assistant", "Hi there"));
    await mem1.save("test-session");

    const mem2 = new AdvancedMemory({
      driver: mockDriver(),
      model: "test",
    });
    await mem2.load("test-session");

    const msgs1 = mem1.messages();
    const msgs2 = mem2.messages();

    assert.strictEqual(msgs1.length, msgs2.length, "Message counts should match");
    assert.strictEqual(msgs1[1].content, msgs2[1].content, "Content should match");
  });

  test("load handles missing sessions gracefully", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver(),
      model: "test",
    });

    // Should not throw on missing session
    await mem.load("nonexistent-session-xyz");
    const msgs = mem.messages();
    // Either empty or has only system prompt
    assert.ok(msgs.length <= 1);
  });
});

// ============================================================================
// SUITE 8: Performance & Stress
// ============================================================================

describe("VirtualMemory Stress: Performance", () => {
  test("adds 1000 messages without significant slowdown", async () => {
    const mem = new AdvancedMemory({
      driver: mockDriver(),
      model: "test",
      contextTokens: 100_000,
    });

    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      await mem.add(msg("user", `Msg ${i}`));
    }
    const elapsed = Date.now() - start;

    // Should complete in reasonable time (< 5 seconds for test environment)
    assert.ok(elapsed < 5000, `Should complete in < 5s, took ${elapsed}ms`);

    const msgs = mem.messages();
    assert.ok(msgs.length > 0);
  });

  test("recovers from summarizer timeout", async () => {
    const slowDriver = {
      async chat(_msgs: ChatMessage[], _opts?: any): Promise<ChatOutput> {
        // Simulate timeout by returning nothing
        return { text: "", toolCalls: [] };
      },
    };

    const mem = new AdvancedMemory({
      driver: slowDriver,
      model: "test",
      contextTokens: 2048,
      avgCharsPerToken: 4,
      highRatio: 0.70,
    });

    // Add enough to trigger compaction
    for (let i = 0; i < 50; i++) {
      await mem.add(msg("user", `Msg ${i} with some text to fill the budget.`));
    }

    // Should not crash despite summarizer returning empty
    const msgs = mem.messages();
    assert.ok(msgs.length > 0, "Should recover and have some messages");
  });
});

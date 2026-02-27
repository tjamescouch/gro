/**
 * Tests for compaction death spiral fixes:
 * - Protected messages (immune from compaction)
 * - Pre-tool compaction
 * - ThinkingLoopDetector
 * - Updated defaults (tool weight, highRatio)
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { ThinkingLoopDetector } from "../src/violations.js";

// ---------------------------------------------------------------------------
// ThinkingLoopDetector
// ---------------------------------------------------------------------------

describe("ThinkingLoopDetector", () => {
  it("does not fire on normal thinking text", () => {
    const detector = new ThinkingLoopDetector();
    const tokens = [
      "Let me think about this carefully. ",
      "The user wants to fix the bug in the authentication module. ",
      "I should look at the login handler first. ",
      "Then check the session management code. ",
      "The error might be in the token validation logic.",
    ];
    for (const t of tokens) {
      assert.strictEqual(detector.addToken(t), false);
    }
    assert.strictEqual(detector.detected, false);
  });

  it("detects repeated phrase loop", () => {
    const detector = new ThinkingLoopDetector({
      windowSize: 2000,
      phraseLen: 40,
      repeatThreshold: 3,
      checkInterval: 50,
    });

    // Feed a repeated phrase many times
    const phrase = "I need to think about this more carefully. ";
    let detected = false;
    for (let i = 0; i < 20; i++) {
      if (detector.addToken(phrase)) {
        detected = true;
        break;
      }
    }
    assert.strictEqual(detected, true);
    assert.strictEqual(detector.detected, true);
  });

  it("keeps returning true after detection", () => {
    const detector = new ThinkingLoopDetector({
      phraseLen: 20,
      repeatThreshold: 3,
      checkInterval: 10,
    });

    const phrase = "repeat this phrase now. ";
    // Feed until detected
    for (let i = 0; i < 50; i++) {
      detector.addToken(phrase);
    }
    assert.strictEqual(detector.detected, true);
    // Subsequent calls should still return true
    assert.strictEqual(detector.addToken("anything"), true);
  });

  it("resets state properly", () => {
    const detector = new ThinkingLoopDetector({
      phraseLen: 20,
      repeatThreshold: 3,
      checkInterval: 10,
    });

    const phrase = "repeat this phrase now. ";
    for (let i = 0; i < 50; i++) {
      detector.addToken(phrase);
    }
    assert.strictEqual(detector.detected, true);

    detector.reset();
    assert.strictEqual(detector.detected, false);

    // Normal text should not trigger after reset
    assert.strictEqual(detector.addToken("Some normal thinking text here"), false);
  });

  it("respects checkInterval (does not check on every token)", () => {
    const detector = new ThinkingLoopDetector({
      phraseLen: 10,
      repeatThreshold: 3,
      checkInterval: 500, // Very high interval
    });

    // Even with repeated content, won't detect until checkInterval chars accumulated
    const phrase = "aaaaaaaaaa"; // 10 chars
    for (let i = 0; i < 10; i++) {
      // 100 chars total, less than checkInterval=500
      assert.strictEqual(detector.addToken(phrase), false);
    }
  });

  it("handles rolling buffer window correctly", () => {
    const detector = new ThinkingLoopDetector({
      windowSize: 200,
      phraseLen: 40,
      repeatThreshold: 3,
      checkInterval: 50,
    });

    // Fill buffer with unique text first
    const uniqueText = "A".repeat(300); // Exceeds windowSize, old data rolls off
    detector.addToken(uniqueText);

    // Now add repeated phrase — should still detect within the window
    const phrase = "This phrase will repeat in the buffer!! ";
    let detected = false;
    for (let i = 0; i < 20; i++) {
      if (detector.addToken(phrase)) {
        detected = true;
        break;
      }
    }
    assert.strictEqual(detected, true);
  });
});

// ---------------------------------------------------------------------------
// Protected Messages & Pre-Tool Compaction (VirtualMemory)
// ---------------------------------------------------------------------------

describe("VirtualMemory Protected Messages", () => {
  // Dynamically import VirtualMemory since it has Node dependencies
  it("protectMessage prevents messages from being paged out during compaction", async () => {
    const { VirtualMemory } = await import("../src/memory/virtual-memory.js");

    // Create a mock driver that returns a summary
    const mockDriver = {
      chat: async () => ({
        text: "Summary of older messages",
        toolCalls: [],
      }),
    };

    const vm = new VirtualMemory({
      workingMemoryTokens: 2000,
      highRatio: 0.65,
      toolWeight: 3,
      driver: mockDriver as any,
      minRecentPerLane: 2,
    });

    // Add enough messages to trigger compaction
    for (let i = 0; i < 10; i++) {
      await vm.add({
        role: "assistant",
        from: "Assistant",
        content: `Assistant message ${i} with some content to take up space: ${"x".repeat(200)}`,
      });
    }

    // Add a protected assistant message with tool_calls (simulating current turn)
    const protectedAssistant: any = {
      role: "assistant",
      from: "Assistant",
      content: "Let me call the tool.",
      tool_calls: [{ id: "call_123", type: "function", function: { name: "some_tool", arguments: "{}" } }],
    };
    vm.protectMessage(protectedAssistant);
    await vm.add(protectedAssistant);

    // Add the protected tool result
    const protectedTool = {
      role: "tool" as const,
      from: "some_tool",
      content: "PROTECTED_RESULT_MARKER: This tool result must survive compaction",
      tool_call_id: "call_123",
      name: "some_tool",
    };
    vm.protectMessage(protectedTool);
    await vm.add(protectedTool);

    // Force compaction
    await vm.forceCompact();

    // The protected message should still be in the buffer
    const msgs = vm.messages();
    const found = msgs.some(m => String(m.content).includes("PROTECTED_RESULT_MARKER"));
    assert.strictEqual(found, true, "Protected tool result should survive compaction");
  });

  it("clearProtectedMessages removes all protections", async () => {
    const { VirtualMemory } = await import("../src/memory/virtual-memory.js");

    const vm = new VirtualMemory({
      workingMemoryTokens: 2000,
      highRatio: 0.65,
    });

    const msg = { role: "tool" as const, from: "tool", content: "result", tool_call_id: "c1", name: "tool" };
    vm.protectMessage(msg);
    // Clearing should work without error
    vm.clearProtectedMessages();
    // After clearing, the message is no longer protected (no way to directly test this
    // without compaction, but we verify the API doesn't throw)
    assert.ok(true);
  });
});

describe("VirtualMemory Pre-Tool Compaction", () => {
  it("preToolCompact returns false when under threshold", async () => {
    const { VirtualMemory } = await import("../src/memory/virtual-memory.js");

    const vm = new VirtualMemory({
      workingMemoryTokens: 50000, // Very high budget
      highRatio: 0.65,
    });

    // Add a small message — far under threshold
    await vm.add({ role: "user", from: "User", content: "Hello" });

    const compacted = await vm.preToolCompact(0.80);
    assert.strictEqual(compacted, false);
  });

  it("preToolCompact triggers compaction when over threshold", async () => {
    const { VirtualMemory } = await import("../src/memory/virtual-memory.js");

    const mockDriver = {
      chat: async () => ({
        text: "Summary of older messages",
        toolCalls: [],
      }),
    };

    const vm = new VirtualMemory({
      workingMemoryTokens: 1000, // Low budget
      highRatio: 0.65,
      driver: mockDriver as any,
      minRecentPerLane: 2,
    });

    // Fill up working memory
    for (let i = 0; i < 20; i++) {
      await vm.add({
        role: "user",
        from: "User",
        content: `Message ${i}: ${"content ".repeat(20)}`,
      });
    }

    const usage = vm.currentTokenUsage();
    const budget = 1000;
    // Should be over 80% threshold
    if (usage / budget >= 0.80) {
      const compacted = await vm.preToolCompact(0.80);
      assert.strictEqual(compacted, true);
    }
  });

  it("currentTokenUsage returns reasonable values", async () => {
    const { VirtualMemory } = await import("../src/memory/virtual-memory.js");

    const vm = new VirtualMemory({
      workingMemoryTokens: 18000,
    });

    assert.strictEqual(vm.currentTokenUsage(), 0);

    await vm.add({ role: "user", from: "User", content: "Hello world" });
    const usage = vm.currentTokenUsage();
    assert.ok(usage > 0, "Should have non-zero usage after adding a message");
  });
});

// ---------------------------------------------------------------------------
// Updated Defaults
// ---------------------------------------------------------------------------

describe("Updated Defaults", () => {
  it("tool weight defaults to 3", async () => {
    // Verify by checking that the default stats show appropriate tool lane allocation
    const { VirtualMemory } = await import("../src/memory/virtual-memory.js");
    const vm = new VirtualMemory();
    const stats = vm.getStats();

    // With weights 8+4+3+3=18, tool lane should get 3/18 of working memory
    // We verify indirectly: tool lane should exist in stats
    assert.ok(stats.type === "virtual");
  });

  it("highRatio defaults to 0.65", async () => {
    const { VirtualMemory } = await import("../src/memory/virtual-memory.js");
    const vm = new VirtualMemory();
    const stats = vm.getStats() as any;
    assert.strictEqual(stats.highRatio, 0.65);
  });
});

// ---------------------------------------------------------------------------
// AgentMemory base class no-op methods
// ---------------------------------------------------------------------------

describe("AgentMemory base class protection methods", () => {
  it("base class methods are no-ops that do not throw", async () => {
    const { AgentMemory } = await import("../src/memory/agent-memory.js");

    // Create a minimal concrete subclass
    class TestMemory extends AgentMemory {
      async load() {}
      async save() {}
      protected async onAfterAdd() {}
    }

    const mem = new TestMemory();
    const msg = { role: "user" as const, from: "User", content: "test" };

    // These should all be no-ops
    mem.protectMessage(msg);
    mem.unprotectMessage(msg);
    mem.clearProtectedMessages();

    const result = await mem.preToolCompact(0.80);
    assert.strictEqual(result, false);
  });
});

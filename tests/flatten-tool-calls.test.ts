/**
 * Tests for flattenCompactedToolCalls() in VirtualMemory.
 *
 * Validates that broken tool_call/tool pairs are flattened into plain
 * assistant+tool message pairs after compaction, and that properly-split
 * pairs are left untouched.
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import type { ChatDriver, ChatMessage, ChatOutput } from "../src/drivers/types.js";
import { VirtualMemory } from "../src/memory/virtual-memory.js";

/** Mock driver that returns a canned summary */
function mockDriver(response = "Summary."): ChatDriver {
  return {
    async chat(_msgs: ChatMessage[], _opts?: any): Promise<ChatOutput> {
      return { text: response, toolCalls: [] };
    },
  };
}

/** Helper to create a ChatMessage */
function msg(role: string, content: string, from?: string): ChatMessage {
  return { role, content, from: from ?? role };
}

/** Helper to create an assistant message with tool_calls */
function assistantWithToolCalls(
  toolCalls: Array<{ id: string; name: string; args?: string }>,
  content = "",
  from = "Assistant",
): ChatMessage {
  const m: any = {
    role: "assistant",
    content,
    from,
    tool_calls: toolCalls.map(tc => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.args ?? "{}" },
    })),
  };
  return m;
}

/** Helper to create a tool result message */
function toolResult(callId: string, content: string, name = "some_tool"): ChatMessage {
  return {
    role: "tool",
    content,
    from: name,
    tool_call_id: callId,
    name,
  };
}

/**
 * Access VirtualMemory internals for testing.
 * Since flattenCompactedToolCalls is private, we reach through (vm as any).
 */
function getBuffer(vm: VirtualMemory): ChatMessage[] {
  return (vm as any).messagesBuffer;
}

function setBuffer(vm: VirtualMemory, msgs: ChatMessage[]): void {
  const buf = (vm as any).messagesBuffer as ChatMessage[];
  buf.splice(0, buf.length, ...msgs);
}

function callFlatten(vm: VirtualMemory): void {
  (vm as any).flattenCompactedToolCalls();
}

// ============================================================================
// SUITE 1: Properly-Split Pairs (leave alone)
// ============================================================================

describe("flattenCompactedToolCalls: properly-split pairs", () => {
  test("leaves a properly-split single tool call untouched", () => {
    const vm = new VirtualMemory({ driver: mockDriver() });
    const assistant = assistantWithToolCalls([{ id: "call_1", name: "grep" }]);
    const tool = toolResult("call_1", "found 3 matches", "grep");

    setBuffer(vm, [assistant, tool]);
    callFlatten(vm);

    const buf = getBuffer(vm);
    assert.strictEqual(buf.length, 2, "Should still be 2 messages");
    assert.strictEqual(buf[0].role, "assistant");
    assert.ok((buf[0] as any).tool_calls, "Should retain tool_calls");
    assert.strictEqual(buf[1].role, "tool");
    assert.strictEqual(buf[1].tool_call_id, "call_1");
  });

  test("leaves multi-call properly-split pair untouched", () => {
    const vm = new VirtualMemory({ driver: mockDriver() });
    const assistant = assistantWithToolCalls([
      { id: "call_A", name: "grep" },
      { id: "call_B", name: "read" },
    ]);
    const toolA = toolResult("call_A", "grep result", "grep");
    const toolB = toolResult("call_B", "file content", "read");

    setBuffer(vm, [assistant, toolA, toolB]);
    callFlatten(vm);

    const buf = getBuffer(vm);
    assert.strictEqual(buf.length, 3, "Should still be 3 messages");
    assert.ok((buf[0] as any).tool_calls, "Should retain tool_calls");
  });

  test("properly-split pairs surrounded by other messages", () => {
    const vm = new VirtualMemory({ driver: mockDriver() });
    const messages = [
      msg("user", "Hello"),
      assistantWithToolCalls([{ id: "call_1", name: "bash" }]),
      toolResult("call_1", "ok"),
      msg("user", "Thanks"),
      msg("assistant", "You're welcome"),
    ];

    setBuffer(vm, messages);
    callFlatten(vm);

    const buf = getBuffer(vm);
    assert.strictEqual(buf.length, 5);
    assert.ok((buf[1] as any).tool_calls, "Properly split pair should be untouched");
  });
});

// ============================================================================
// SUITE 2: Broken Pairs (missing tool results)
// ============================================================================

describe("flattenCompactedToolCalls: missing tool results", () => {
  test("flattens assistant with tool_calls but no tool results", () => {
    const vm = new VirtualMemory({ driver: mockDriver() });
    const assistant = assistantWithToolCalls([{ id: "call_1", name: "grep" }]);

    setBuffer(vm, [assistant]);
    callFlatten(vm);

    const buf = getBuffer(vm);
    assert.strictEqual(buf.length, 2, "Should have flattened assistant + synthetic tool");

    // First message: plain assistant (no tool_calls)
    assert.strictEqual(buf[0].role, "assistant");
    assert.ok(!("tool_calls" in buf[0]) || !(buf[0] as any).tool_calls,
      "Flattened assistant should NOT have tool_calls");
    assert.ok(buf[0].content.includes("I called grep"), "Should summarize the call");
    assert.ok(buf[0].content.includes("truncated during compaction"),
      "Should note missing result");
    assert.ok((buf[0] as any).metadata?.summarized_tool_call,
      "Should have metadata.summarized_tool_call");

    // Second message: tool result
    assert.strictEqual(buf[1].role, "tool");
    assert.strictEqual(buf[1].tool_call_id, "call_1");
  });

  test("flattens multi-call assistant with all results missing", () => {
    const vm = new VirtualMemory({ driver: mockDriver() });
    const assistant = assistantWithToolCalls([
      { id: "call_A", name: "grep" },
      { id: "call_B", name: "read" },
    ]);

    setBuffer(vm, [assistant]);
    callFlatten(vm);

    const buf = getBuffer(vm);
    // Each tool call becomes 2 messages (assistant + tool)
    assert.strictEqual(buf.length, 4,
      "2 tool calls → 4 messages (2 × assistant+tool)");

    assert.strictEqual(buf[0].role, "assistant");
    assert.ok(buf[0].content.includes("grep"));
    assert.strictEqual(buf[1].role, "tool");
    assert.strictEqual(buf[1].tool_call_id, "call_A");

    assert.strictEqual(buf[2].role, "assistant");
    assert.ok(buf[2].content.includes("read"));
    assert.strictEqual(buf[3].role, "tool");
    assert.strictEqual(buf[3].tool_call_id, "call_B");
  });

  test("flattens when only some results are missing", () => {
    const vm = new VirtualMemory({ driver: mockDriver() });
    const assistant = assistantWithToolCalls([
      { id: "call_A", name: "grep" },
      { id: "call_B", name: "read" },
    ]);
    // Only call_A has a result, but it's not immediately after (user message intervenes)
    const toolA = toolResult("call_A", "grep result", "grep");

    // Place tool result non-adjacently (broken pair)
    setBuffer(vm, [assistant, msg("user", "interruption"), toolA]);
    callFlatten(vm);

    const buf = getBuffer(vm);
    // Assistant should be flattened (results not adjacent)
    // call_A result exists but was elsewhere → consumed by flattening
    // call_B result missing → truncated
    const assistantMsgs = buf.filter(m => m.role === "assistant");
    const toolMsgs = buf.filter(m => m.role === "tool");

    assert.ok(assistantMsgs.length >= 2, "Each tool call should produce a flattened assistant");
    assert.ok(toolMsgs.length >= 2, "Each tool call should produce a flattened tool msg");
    assert.ok(!assistantMsgs.some(m => (m as any).tool_calls),
      "No flattened assistant should have tool_calls");
  });
});

// ============================================================================
// SUITE 3: Out-of-Order Tool Results
// ============================================================================

describe("flattenCompactedToolCalls: out-of-order results", () => {
  test("flattens when tool result appears before its assistant", () => {
    const vm = new VirtualMemory({ driver: mockDriver() });
    // Tool result first (orphaned position), assistant later
    const tool = toolResult("call_1", "early result", "grep");
    const assistant = assistantWithToolCalls([{ id: "call_1", name: "grep" }]);

    setBuffer(vm, [tool, assistant]);
    callFlatten(vm);

    const buf = getBuffer(vm);
    // The tool result should be consumed by flattening (not duplicated)
    const toolMsgs = buf.filter(m => m.role === "tool");
    assert.strictEqual(toolMsgs.length, 1,
      "Should have exactly 1 tool message (from flattening)");
    assert.ok(toolMsgs[0].content.includes("early result"),
      "Flattened tool should contain the original result");
  });

  test("flattens when results are scattered across buffer", () => {
    const vm = new VirtualMemory({ driver: mockDriver() });
    const assistant = assistantWithToolCalls([
      { id: "call_A", name: "grep" },
      { id: "call_B", name: "read" },
    ]);
    const toolA = toolResult("call_A", "grep result", "grep");
    const toolB = toolResult("call_B", "file content", "read");

    // Scatter results with non-tool messages in between
    setBuffer(vm, [
      assistant,
      toolA,
      msg("user", "interruption"),
      toolB,
    ]);
    callFlatten(vm);

    const buf = getBuffer(vm);
    // Assistant should be flattened because toolB is not adjacent
    const flatAssistants = buf.filter(m =>
      m.role === "assistant" && (m as any).metadata?.summarized_tool_call
    );
    assert.strictEqual(flatAssistants.length, 2,
      "Both tool calls should be flattened");
  });
});

// ============================================================================
// SUITE 4: Dangling Tool Results
// ============================================================================

describe("flattenCompactedToolCalls: dangling tool results", () => {
  test("skips dangling tool result with no matching tool_calls", () => {
    const vm = new VirtualMemory({ driver: mockDriver() });
    const dangling = toolResult("orphan_1", "orphaned result", "unknown");

    setBuffer(vm, [msg("user", "hello"), dangling, msg("assistant", "hi")]);
    callFlatten(vm);

    const buf = getBuffer(vm);
    // Dangling tool should be skipped
    const toolMsgs = buf.filter(m => m.role === "tool");
    assert.strictEqual(toolMsgs.length, 0, "Dangling tool results should be skipped");
    // Other messages preserved
    assert.strictEqual(buf.length, 2);
  });

  test("skips multiple dangling tool results", () => {
    const vm = new VirtualMemory({ driver: mockDriver() });
    setBuffer(vm, [
      toolResult("orphan_1", "r1", "tool1"),
      toolResult("orphan_2", "r2", "tool2"),
      msg("user", "hello"),
    ]);
    callFlatten(vm);

    const buf = getBuffer(vm);
    assert.strictEqual(buf.length, 1, "Only the user message should remain");
    assert.strictEqual(buf[0].content, "hello");
  });
});

// ============================================================================
// SUITE 5: Mixed Scenarios
// ============================================================================

describe("flattenCompactedToolCalls: mixed scenarios", () => {
  test("handles mix of properly-split and broken pairs", () => {
    const vm = new VirtualMemory({ driver: mockDriver() });
    const goodAssistant = assistantWithToolCalls([{ id: "good_1", name: "bash" }]);
    const goodTool = toolResult("good_1", "success", "bash");

    const brokenAssistant = assistantWithToolCalls([{ id: "broken_1", name: "grep" }]);
    // No tool result for broken_1

    setBuffer(vm, [
      goodAssistant,
      goodTool,
      msg("user", "next task"),
      brokenAssistant,
    ]);
    callFlatten(vm);

    const buf = getBuffer(vm);

    // Good pair should be untouched
    assert.ok((buf[0] as any).tool_calls, "Properly-split pair preserved");
    assert.strictEqual(buf[1].role, "tool");
    assert.strictEqual(buf[1].tool_call_id, "good_1");

    // User message preserved
    assert.strictEqual(buf[2].content, "next task");

    // Broken pair should be flattened
    const flattenedAssistant = buf[3];
    assert.ok(flattenedAssistant.content.includes("I called grep"),
      "Broken pair should be flattened");
    assert.ok(!(flattenedAssistant as any).tool_calls,
      "Flattened assistant should NOT have tool_calls");
    assert.strictEqual(buf[4].role, "tool");
    assert.strictEqual(buf[4].tool_call_id, "broken_1");
  });

  test("preserves non-tool messages exactly", () => {
    const vm = new VirtualMemory({ driver: mockDriver() });
    setBuffer(vm, [
      msg("system", "You are helpful"),
      msg("user", "Hello"),
      msg("assistant", "Hi there"),
      msg("user", "Thanks"),
    ]);
    callFlatten(vm);

    const buf = getBuffer(vm);
    assert.strictEqual(buf.length, 4, "All non-tool messages preserved");
    assert.strictEqual(buf[0].content, "You are helpful");
    assert.strictEqual(buf[1].content, "Hello");
    assert.strictEqual(buf[2].content, "Hi there");
    assert.strictEqual(buf[3].content, "Thanks");
  });

  test("handles empty buffer", () => {
    const vm = new VirtualMemory({ driver: mockDriver() });
    setBuffer(vm, []);
    callFlatten(vm);
    assert.strictEqual(getBuffer(vm).length, 0);
  });

  test("handles buffer with only system message", () => {
    const vm = new VirtualMemory({ driver: mockDriver() });
    setBuffer(vm, [msg("system", "You are helpful")]);
    callFlatten(vm);
    const buf = getBuffer(vm);
    assert.strictEqual(buf.length, 1);
    assert.strictEqual(buf[0].content, "You are helpful");
  });
});

// ============================================================================
// SUITE 6: Metadata Verification
// ============================================================================

describe("flattenCompactedToolCalls: metadata format", () => {
  test("flattened message has correct metadata structure", () => {
    const vm = new VirtualMemory({ driver: mockDriver() });
    const assistant = assistantWithToolCalls([{
      id: "call_42",
      name: "grep",
      args: '{"pattern":"foo","path":"/src"}',
    }]);
    const tool = toolResult("call_42", "matched: src/main.ts:10", "grep");

    // Break the pair by inserting non-tool message between
    setBuffer(vm, [assistant, msg("user", "interruption"), tool]);
    callFlatten(vm);

    const buf = getBuffer(vm);
    const flatAssistant = buf.find(m =>
      m.role === "assistant" && (m as any).metadata?.summarized_tool_call
    );

    assert.ok(flatAssistant, "Should have a flattened assistant with metadata");

    const meta = (flatAssistant as any).metadata.summarized_tool_call;
    assert.strictEqual(meta.id, "call_42");
    assert.strictEqual(meta.function, "grep");
    assert.deepStrictEqual(meta.args, { pattern: "foo", path: "/src" });
    assert.ok(meta.result.includes("matched: src/main.ts:10"),
      "Result should contain the tool output");
  });

  test("result snippet is truncated at 200 chars", () => {
    const vm = new VirtualMemory({ driver: mockDriver() });
    const longResult = "x".repeat(500);
    const assistant = assistantWithToolCalls([{ id: "call_1", name: "read" }]);

    // Tool result exists but not adjacent
    setBuffer(vm, [
      assistant,
      msg("user", "break"),
      toolResult("call_1", longResult, "read"),
    ]);
    callFlatten(vm);

    const buf = getBuffer(vm);
    const flatAssistant = buf.find(m =>
      m.role === "assistant" && (m as any).metadata?.summarized_tool_call
    );
    const meta = (flatAssistant as any).metadata.summarized_tool_call;

    assert.ok(meta.result.length <= 204, // 200 chars + "..."
      `Result should be truncated. Got ${meta.result.length} chars`);
    assert.ok(meta.result.endsWith("..."), "Truncated result should end with ...");
  });

  test("args snippet is truncated at 100 chars", () => {
    const vm = new VirtualMemory({ driver: mockDriver() });
    const longArgs = JSON.stringify({ data: "x".repeat(200) });
    const assistant = assistantWithToolCalls([{
      id: "call_1",
      name: "write",
      args: longArgs,
    }]);

    setBuffer(vm, [assistant]);
    callFlatten(vm);

    const buf = getBuffer(vm);
    const flatAssistant = buf[0];
    // Content should have truncated args
    assert.ok(flatAssistant.content.includes("..."),
      "Long args should be truncated in content");
  });
});

// ============================================================================
// SUITE 7: End-to-End with VirtualMemory Compaction
// ============================================================================

describe("flattenCompactedToolCalls: end-to-end with compaction", () => {
  test("tool calls survive compaction cycle without tool_calls field", async () => {
    const vm = new VirtualMemory({
      driver: mockDriver("Compacted summary of tool operations."),
      workingMemoryTokens: 800,
      pageSlotTokens: 400,
      avgCharsPerToken: 2.8,
      minRecentPerLane: 2,
      highRatio: 0.60,
      lowRatio: 0.40,
    });

    // Add enough content to trigger compaction, including tool calls
    for (let i = 0; i < 15; i++) {
      await vm.add(msg("user", `Request ${i}: do something with ${"x".repeat(50)}`));

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: `Working on request ${i}`,
        from: "Assistant",
      };
      (assistantMsg as any).tool_calls = [{
        id: `call_${i}`,
        type: "function",
        function: { name: "bash", arguments: `{"command":"echo ${i}"}` },
      }];
      await vm.add(assistantMsg);

      await vm.add({
        role: "tool",
        content: `Output: ${i}`,
        from: "bash",
        tool_call_id: `call_${i}`,
        name: "bash",
      });
    }

    // Get the final message buffer
    const msgs = vm.messages();

    // After compaction + flattening, verify no orphaned tool_calls
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const tc = (m as any).tool_calls;

      if (m.role === "assistant" && Array.isArray(tc) && tc.length > 0) {
        // This assistant has tool_calls — verify ALL results immediately follow
        for (const call of tc) {
          const resultIdx = msgs.findIndex((r, j) =>
            j > i && r.role === "tool" && r.tool_call_id === call.id
          );
          assert.ok(resultIdx > i,
            `tool_call ${call.id} should have a matching tool result after it`);
          assert.ok(resultIdx <= i + tc.length,
            `tool result for ${call.id} should be immediately after the assistant`);
        }
      }
    }

    // Verify flattened messages exist (compaction should have happened)
    const flattenedMsgs = msgs.filter(m =>
      m.role === "assistant" && (m as any).metadata?.summarized_tool_call
    );
    // Either compaction happened (flattened msgs exist) or budget was large enough (no compaction)
    // In either case, no orphaned tool_calls should exist
    const orphanedToolCalls: string[] = [];
    for (const m of msgs) {
      const tc = (m as any).tool_calls;
      if (m.role === "assistant" && Array.isArray(tc)) {
        for (const call of tc) {
          const hasResult = msgs.some(r =>
            r.role === "tool" && r.tool_call_id === call.id
          );
          if (!hasResult) orphanedToolCalls.push(call.id);
        }
      }
    }
    assert.strictEqual(orphanedToolCalls.length, 0,
      `No orphaned tool_calls should exist. Orphaned: ${orphanedToolCalls.join(", ")}`);
  });

  test("heavy compaction with many tool calls produces valid output", async () => {
    const vm = new VirtualMemory({
      driver: mockDriver("Summary with tool context."),
      workingMemoryTokens: 600,
      pageSlotTokens: 300,
      avgCharsPerToken: 2.8,
      minRecentPerLane: 1,
      highRatio: 0.50,
      lowRatio: 0.30,
    });

    // Hammer it with tool calls
    for (let i = 0; i < 25; i++) {
      await vm.add(msg("user", `Task ${i}`));

      const a: ChatMessage = {
        role: "assistant",
        content: `Executing task ${i}`,
        from: "Assistant",
      };
      (a as any).tool_calls = [
        { id: `call_${i}_a`, type: "function", function: { name: "grep", arguments: `{"q":"${i}"}` } },
        { id: `call_${i}_b`, type: "function", function: { name: "read", arguments: `{"f":"${i}.ts"}` } },
      ];
      await vm.add(a);

      await vm.add(toolResult(`call_${i}_a`, `grep: ${i} matches`, "grep"));
      await vm.add(toolResult(`call_${i}_b`, `read: file ${i} content`, "read"));
    }

    const msgs = vm.messages();

    // Validate: every tool message should have a way to trace back
    // Either it's part of a properly-split pair or it's a flattened pair
    for (const m of msgs) {
      if (m.role === "tool" && m.tool_call_id) {
        // Find the assistant that owns this tool_call_id
        const ownerIdx = msgs.findIndex(a => {
          const tc = (a as any).tool_calls;
          return a.role === "assistant" && Array.isArray(tc) &&
            tc.some((c: any) => c.id === m.tool_call_id);
        });
        // Or it should be preceded by a flattened assistant with matching metadata
        const flatOwnerIdx = msgs.findIndex(a =>
          a.role === "assistant" &&
          (a as any).metadata?.summarized_tool_call?.id === m.tool_call_id
        );

        assert.ok(ownerIdx >= 0 || flatOwnerIdx >= 0,
          `Tool result ${m.tool_call_id} should have an owner (tool_calls or flattened)`);
      }
    }

    // No assistant should have tool_calls with missing results
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const tc = (m as any).tool_calls;
      if (m.role === "assistant" && Array.isArray(tc)) {
        for (const call of tc) {
          const hasResult = msgs.some(r =>
            r.role === "tool" && r.tool_call_id === call.id
          );
          assert.ok(hasResult,
            `tool_call ${call.id} (${call.function?.name}) must have a result`);
        }
      }
    }
  });
});

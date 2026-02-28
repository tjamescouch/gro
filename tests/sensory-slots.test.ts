/**
 * Tests for sensory slot management — switchView and cycleSlot0.
 *
 * switchView blocks non-viewable channels (like 'self') from camera slots.
 * cycleSlot0 skips non-viewable channels when cycling.
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { SensoryMemory } from "../src/memory/sensory-memory.js";
import { SimpleMemory } from "../src/memory/simple-memory.js";

// --- Helpers ---

/** Create a SensoryMemory with standard channels registered. */
function makeSensory(channelNames = ["context", "time", "config", "self", "tasks"]): SensoryMemory {
  const inner = new SimpleMemory();
  const sensory = new SensoryMemory(inner, { totalBudget: 500 });
  for (const name of channelNames) {
    sensory.addChannel({
      name,
      maxTokens: 100,
      updateMode: "every_turn",
      content: "",
      enabled: name !== "self",
      viewable: name !== "self",
    });
  }
  return sensory;
}

// =============================================================================
// switchView — blocking non-viewable channels
// =============================================================================

describe("switchView", () => {
  test("assigns valid channel to slot 0", () => {
    const sensory = makeSensory();
    sensory.switchView("context", 0);
    assert.strictEqual(sensory.getSlot(0), "context");
  });

  test("assigns valid channel to slot 1", () => {
    const sensory = makeSensory();
    sensory.switchView("time", 1);
    assert.strictEqual(sensory.getSlot(1), "time");
  });

  test("assigns valid channel to slot 2", () => {
    const sensory = makeSensory();
    sensory.switchView("config", 2);
    assert.strictEqual(sensory.getSlot(2), "config");
  });

  test("rejects 'self' — does not modify slot", () => {
    const sensory = makeSensory();
    sensory.setSlot(0, "context");
    sensory.switchView("self", 0);
    assert.strictEqual(sensory.getSlot(0), "context", "self should not displace context");
  });

  test("rejects 'self' on all three slots", () => {
    const sensory = makeSensory();
    sensory.setSlot(0, "context");
    sensory.setSlot(1, "time");
    sensory.setSlot(2, "config");
    sensory.switchView("self", 0);
    sensory.switchView("self", 1);
    sensory.switchView("self", 2);
    assert.strictEqual(sensory.getSlot(0), "context");
    assert.strictEqual(sensory.getSlot(1), "time");
    assert.strictEqual(sensory.getSlot(2), "config");
  });

  test("rejects unknown channel name", () => {
    const sensory = makeSensory();
    sensory.setSlot(0, "context");
    sensory.switchView("nonexistent", 0);
    assert.strictEqual(sensory.getSlot(0), "context");
  });

  test("allows tasks channel (viewable)", () => {
    const sensory = makeSensory();
    sensory.switchView("tasks", 0);
    assert.strictEqual(sensory.getSlot(0), "tasks");
  });
});

// =============================================================================
// cycleSlot0 — skips non-viewable channels
// =============================================================================

describe("cycleSlot0", () => {
  test("cycles forward through viewable channels", () => {
    const sensory = makeSensory(["context", "time", "config", "self", "tasks"]);
    sensory.setSlot(0, "context");
    sensory.cycleSlot0("next");
    assert.strictEqual(sensory.getSlot(0), "time");
    sensory.cycleSlot0("next");
    assert.strictEqual(sensory.getSlot(0), "config");
    sensory.cycleSlot0("next");
    assert.strictEqual(sensory.getSlot(0), "tasks");
    sensory.cycleSlot0("next");
    assert.strictEqual(sensory.getSlot(0), "context"); // wraps around
  });

  test("never lands on 'self'", () => {
    const sensory = makeSensory(["context", "self", "time"]);
    sensory.setSlot(0, "context");
    const visited: string[] = [];
    for (let i = 0; i < 10; i++) {
      sensory.cycleSlot0("next");
      visited.push(sensory.getSlot(0)!);
    }
    assert.ok(!visited.includes("self"), `'self' should never appear in cycle, got: ${visited}`);
  });

  test("cycles backward", () => {
    const sensory = makeSensory(["context", "time", "config"]);
    sensory.setSlot(0, "context");
    sensory.cycleSlot0("prev");
    assert.strictEqual(sensory.getSlot(0), "config");
    sensory.cycleSlot0("prev");
    assert.strictEqual(sensory.getSlot(0), "time");
  });
});

/**
 * Tests for session persistence.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// We need to override cwd for the session module since it uses process.cwd()
const tmpDir = path.join(os.tmpdir(), `gro-session-test-${Date.now()}`);
const origCwd = process.cwd();

describe("Session", () => {
  before(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    process.chdir(tmpDir);
  });

  after(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("ensureGroDir creates .gro/context/", async () => {
    const { ensureGroDir } = await import("../src/session.js");
    ensureGroDir();
    assert.ok(fs.existsSync(path.join(tmpDir, ".gro", "context")));
  });

  test("newSessionId returns a short string", async () => {
    const { newSessionId } = await import("../src/session.js");
    const id = newSessionId();
    assert.ok(id.length > 0 && id.length <= 36);
    assert.ok(/^[a-f0-9]+$/.test(id), `Expected hex string, got: ${id}`);
  });

  test("saveSession and loadSession round-trip", async () => {
    const { saveSession, loadSession, ensureGroDir } = await import("../src/session.js");
    ensureGroDir();

    const messages = [
      { role: "system", from: "System", content: "Be helpful." },
      { role: "user", from: "User", content: "Hello" },
      { role: "assistant", from: "Assistant", content: "Hi there!" },
    ];
    const meta = { provider: "anthropic", model: "claude-test" };

    saveSession("test-session-1", messages, meta);
    const loaded = loadSession("test-session-1");

    assert.ok(loaded !== null);
    assert.strictEqual(loaded!.messages.length, 3);
    assert.strictEqual(loaded!.messages[0].content, "Be helpful.");
    assert.strictEqual(loaded!.messages[2].content, "Hi there!");
    assert.strictEqual(loaded!.meta.provider, "anthropic");
    assert.ok(loaded!.meta.updatedAt, "Should have updatedAt timestamp");
  });

  test("loadSession returns null for missing session", async () => {
    const { loadSession } = await import("../src/session.js");
    const result = loadSession("nonexistent-session");
    assert.strictEqual(result, null);
  });

  test("findLatestSession returns most recent", async () => {
    const { saveSession, findLatestSession, ensureGroDir } = await import("../src/session.js");
    ensureGroDir();

    saveSession("older-session", [{ role: "user", from: "User", content: "old" }], {});
    // Small delay to ensure different mtime
    await new Promise(r => setTimeout(r, 50));
    saveSession("newer-session", [{ role: "user", from: "User", content: "new" }], {});

    const latest = findLatestSession();
    assert.strictEqual(latest, "newer-session");
  });
});

/**
 * Tests for structured error types (GroError).
 *
 * Covers: groError, asError, isGroError, errorLogFields
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { groError, asError, isGroError, errorLogFields } from "../src/errors.js";
import type { GroError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// groError factory
// ---------------------------------------------------------------------------

describe("groError", () => {
  test("creates an Error with kind and retryable fields", () => {
    const e = groError("provider_error", "API failed");
    assert.ok(e instanceof Error);
    assert.strictEqual(e.kind, "provider_error");
    assert.strictEqual(e.message, "API failed");
    assert.strictEqual(e.retryable, false); // default
    assert.ok(e.stack, "should have a stack trace");
  });

  test("retryable defaults to false", () => {
    const e = groError("tool_error", "boom");
    assert.strictEqual(e.retryable, false);
  });

  test("retryable can be set to true", () => {
    const e = groError("provider_error", "429", { retryable: true });
    assert.strictEqual(e.retryable, true);
  });

  test("optional fields are set when provided", () => {
    const e = groError("provider_error", "fail", {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      request_id: "req_123",
      latency_ms: 450,
      cause: new Error("underlying"),
    });
    assert.strictEqual(e.provider, "anthropic");
    assert.strictEqual(e.model, "claude-sonnet-4-20250514");
    assert.strictEqual(e.request_id, "req_123");
    assert.strictEqual(e.latency_ms, 450);
    assert.ok(e.cause instanceof Error);
  });

  test("optional fields are omitted when not provided", () => {
    const e = groError("config_error", "bad config");
    assert.strictEqual(e.provider, undefined);
    assert.strictEqual(e.model, undefined);
    assert.strictEqual(e.request_id, undefined);
    assert.strictEqual(e.latency_ms, undefined);
    assert.strictEqual(e.cause, undefined);
  });

  test("all GroErrorKind values are accepted", () => {
    const kinds = [
      "provider_error",
      "tool_error",
      "config_error",
      "mcp_error",
      "timeout_error",
      "session_error",
    ] as const;
    for (const kind of kinds) {
      const e = groError(kind, `test ${kind}`);
      assert.strictEqual(e.kind, kind);
    }
  });

  test("latency_ms of 0 is preserved (not treated as falsy)", () => {
    const e = groError("provider_error", "fast fail", { latency_ms: 0 });
    assert.strictEqual(e.latency_ms, 0);
  });
});

// ---------------------------------------------------------------------------
// asError
// ---------------------------------------------------------------------------

describe("asError", () => {
  test("returns Error instances unchanged", () => {
    const original = new Error("original");
    const result = asError(original);
    assert.strictEqual(result, original);
  });

  test("wraps strings into Error", () => {
    const result = asError("something broke");
    assert.ok(result instanceof Error);
    assert.strictEqual(result.message, "something broke");
  });

  test("truncates long strings to 1024 chars", () => {
    const long = "x".repeat(2000);
    const result = asError(long);
    assert.strictEqual(result.message.length, 1024);
  });

  test("handles null", () => {
    const result = asError(null);
    assert.ok(result instanceof Error);
    assert.strictEqual(result.message, "Unknown error");
  });

  test("handles undefined", () => {
    const result = asError(undefined);
    assert.ok(result instanceof Error);
    assert.strictEqual(result.message, "Unknown error");
  });

  test("handles objects via String()", () => {
    const result = asError({ code: 42 });
    assert.ok(result instanceof Error);
    assert.ok(result.message.includes("[object Object]"));
  });

  test("handles numbers", () => {
    const result = asError(42);
    assert.ok(result instanceof Error);
    assert.strictEqual(result.message, "42");
  });

  test("truncates long stringified values with ellipsis", () => {
    // Use a value whose String() representation exceeds 1024 chars
    const longStr = "z".repeat(2000);
    const result = asError(longStr);
    // String input goes through the string branch (slice to 1024, no ellipsis)
    assert.strictEqual(result.message.length, 1024);

    // For non-string values, String() > 1024 gets ellipsis
    const longToString = { toString: () => "w".repeat(2000) };
    const result2 = asError(longToString);
    assert.ok(result2.message.endsWith("..."));
    assert.strictEqual(result2.message.length, 1027); // 1024 + "..."
  });
});

// ---------------------------------------------------------------------------
// isGroError
// ---------------------------------------------------------------------------

describe("isGroError", () => {
  test("returns true for groError instances", () => {
    const e = groError("provider_error", "test");
    assert.strictEqual(isGroError(e), true);
  });

  test("returns false for plain Error", () => {
    assert.strictEqual(isGroError(new Error("nope")), false);
  });

  test("returns false for non-Error objects", () => {
    assert.strictEqual(isGroError({ kind: "provider_error", retryable: true }), false);
  });

  test("returns false for null", () => {
    assert.strictEqual(isGroError(null), false);
  });

  test("returns false for undefined", () => {
    assert.strictEqual(isGroError(undefined), false);
  });

  test("returns false for strings", () => {
    assert.strictEqual(isGroError("error"), false);
  });

  test("returns true for Error manually augmented with kind and retryable", () => {
    const e = new Error("manual") as any;
    e.kind = "tool_error";
    e.retryable = false;
    assert.strictEqual(isGroError(e), true);
  });
});

// ---------------------------------------------------------------------------
// errorLogFields
// ---------------------------------------------------------------------------

describe("errorLogFields", () => {
  test("returns basic fields for minimal GroError", () => {
    const e = groError("config_error", "bad");
    const fields = errorLogFields(e);
    assert.strictEqual(fields.kind, "config_error");
    assert.strictEqual(fields.message, "bad");
    assert.strictEqual(fields.retryable, false);
    assert.ok(fields.stack, "should include stack");
  });

  test("includes optional fields when present", () => {
    const e = groError("provider_error", "fail", {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      request_id: "req_abc",
      latency_ms: 100,
    });
    const fields = errorLogFields(e);
    assert.strictEqual(fields.provider, "anthropic");
    assert.strictEqual(fields.model, "claude-sonnet-4-20250514");
    assert.strictEqual(fields.request_id, "req_abc");
    assert.strictEqual(fields.latency_ms, 100);
  });

  test("omits optional fields when not set", () => {
    const e = groError("tool_error", "boom");
    const fields = errorLogFields(e);
    assert.strictEqual(fields.provider, undefined);
    assert.strictEqual(fields.model, undefined);
    assert.strictEqual(fields.request_id, undefined);
    assert.strictEqual(fields.latency_ms, undefined);
  });

  test("resolves cause into cause_message and cause_stack", () => {
    const cause = new Error("root cause");
    const e = groError("mcp_error", "mcp failed", { cause });
    const fields = errorLogFields(e);
    assert.strictEqual(fields.cause_message, "root cause");
    assert.ok(fields.cause_stack);
  });

  test("resolves non-Error cause via asError", () => {
    const e = groError("provider_error", "fail", { cause: "string cause" });
    const fields = errorLogFields(e);
    assert.strictEqual(fields.cause_message, "string cause");
  });

  test("result is JSON-serializable", () => {
    const e = groError("provider_error", "test", {
      provider: "openai",
      model: "gpt-4o",
      request_id: "req_1",
      latency_ms: 200,
      cause: new Error("inner"),
    });
    const fields = errorLogFields(e);
    const json = JSON.stringify(fields);
    assert.ok(json.length > 0);
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.kind, "provider_error");
  });
});

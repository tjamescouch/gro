/**
 * Tests for RateLimiter.
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { rateLimiter } from "../src/utils/rate-limiter.js";

describe("RateLimiter", () => {
  test("first call returns immediately", async () => {
    rateLimiter.reset("test-immediate");
    const start = Date.now();
    await rateLimiter.limit("test-immediate", 10);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, `First call should be near-instant, took ${elapsed}ms`);
  });

  test("second call is delayed", async () => {
    rateLimiter.reset("test-delay");
    await rateLimiter.limit("test-delay", 2); // 2 per second = 500ms interval
    const start = Date.now();
    await rateLimiter.limit("test-delay", 2);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 400, `Second call should wait ~500ms, took ${elapsed}ms`);
    assert.ok(elapsed < 800, `Should not wait too long, took ${elapsed}ms`);
  });

  test("different keys are independent", async () => {
    rateLimiter.reset();
    await rateLimiter.limit("key-a", 1);
    const start = Date.now();
    await rateLimiter.limit("key-b", 1); // different key, no wait
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, `Different key should not wait, took ${elapsed}ms`);
  });

  test("throws on invalid throughput", async () => {
    await assert.rejects(
      () => rateLimiter.limit("bad", 0),
      /positive finite number/
    );
    await assert.rejects(
      () => rateLimiter.limit("bad", -1),
      /positive finite number/
    );
    await assert.rejects(
      () => rateLimiter.limit("bad", Infinity),
      /positive finite number/
    );
    await assert.rejects(
      () => rateLimiter.limit("bad", NaN),
      /positive finite number/
    );
  });

  test("reset clears state", async () => {
    rateLimiter.reset("test-reset");
    await rateLimiter.limit("test-reset", 1); // first call
    rateLimiter.reset("test-reset"); // reset
    const start = Date.now();
    await rateLimiter.limit("test-reset", 1); // should be instant after reset
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, `After reset should be instant, took ${elapsed}ms`);
  });

  test("reset() without args clears all keys", async () => {
    await rateLimiter.limit("x1", 1);
    await rateLimiter.limit("x2", 1);
    rateLimiter.reset();
    const start = Date.now();
    await rateLimiter.limit("x1", 1);
    await rateLimiter.limit("x2", 1);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, `After global reset both should be instant, took ${elapsed}ms`);
  });
});

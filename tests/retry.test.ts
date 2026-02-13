/**
 * Tests for retry utilities.
 *
 * Covers: isRetryable, retryDelay, sleep, MAX_RETRIES, RETRY_BASE_MS
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { isRetryable, retryDelay, sleep, MAX_RETRIES, RETRY_BASE_MS } from "../src/utils/retry.js";

// ---------------------------------------------------------------------------
// isRetryable
// ---------------------------------------------------------------------------

describe("isRetryable", () => {
  test("429 (rate limited) is retryable", () => {
    assert.strictEqual(isRetryable(429), true);
  });

  test("502 (bad gateway) is retryable", () => {
    assert.strictEqual(isRetryable(502), true);
  });

  test("503 (service unavailable) is retryable", () => {
    assert.strictEqual(isRetryable(503), true);
  });

  test("529 (overloaded) is retryable", () => {
    assert.strictEqual(isRetryable(529), true);
  });

  test("200 is not retryable", () => {
    assert.strictEqual(isRetryable(200), false);
  });

  test("400 (bad request) is not retryable", () => {
    assert.strictEqual(isRetryable(400), false);
  });

  test("401 (unauthorized) is not retryable", () => {
    assert.strictEqual(isRetryable(401), false);
  });

  test("403 (forbidden) is not retryable", () => {
    assert.strictEqual(isRetryable(403), false);
  });

  test("404 (not found) is not retryable", () => {
    assert.strictEqual(isRetryable(404), false);
  });

  test("500 (internal server error) is not retryable", () => {
    assert.strictEqual(isRetryable(500), false);
  });
});

// ---------------------------------------------------------------------------
// retryDelay
// ---------------------------------------------------------------------------

describe("retryDelay", () => {
  test("attempt 0 returns delay in [1000, 1500) range", () => {
    // base = 1000 * 2^0 = 1000, jitter = [0, 500)
    for (let i = 0; i < 100; i++) {
      const delay = retryDelay(0);
      assert.ok(delay >= 1000, `delay ${delay} should be >= 1000`);
      assert.ok(delay < 1500, `delay ${delay} should be < 1500`);
    }
  });

  test("attempt 1 returns delay in [2000, 3000) range", () => {
    // base = 1000 * 2^1 = 2000, jitter = [0, 1000)
    for (let i = 0; i < 100; i++) {
      const delay = retryDelay(1);
      assert.ok(delay >= 2000, `delay ${delay} should be >= 2000`);
      assert.ok(delay < 3000, `delay ${delay} should be < 3000`);
    }
  });

  test("attempt 2 returns delay in [4000, 6000) range", () => {
    // base = 1000 * 2^2 = 4000, jitter = [0, 2000)
    for (let i = 0; i < 100; i++) {
      const delay = retryDelay(2);
      assert.ok(delay >= 4000, `delay ${delay} should be >= 4000`);
      assert.ok(delay < 6000, `delay ${delay} should be < 6000`);
    }
  });

  test("delay increases with attempt number (exponential)", () => {
    // Run enough samples that minimum of higher attempt > maximum of lower attempt (statistically)
    const delays0 = Array.from({ length: 50 }, () => retryDelay(0));
    const delays2 = Array.from({ length: 50 }, () => retryDelay(2));
    const max0 = Math.max(...delays0);
    const min2 = Math.min(...delays2);
    assert.ok(min2 > max0, `min attempt-2 delay (${min2}) should exceed max attempt-0 delay (${max0})`);
  });

  test("includes jitter (not always the same value)", () => {
    const delays = Array.from({ length: 20 }, () => retryDelay(0));
    const unique = new Set(delays);
    assert.ok(unique.size > 1, "delays should vary due to jitter");
  });
});

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

describe("sleep", () => {
  test("resolves after approximately the specified duration", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40, `should wait at least ~50ms, took ${elapsed}ms`);
    assert.ok(elapsed < 200, `should not wait too long, took ${elapsed}ms`);
  });

  test("sleep(0) resolves nearly immediately", async () => {
    const start = Date.now();
    await sleep(0);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 50, `sleep(0) should be near-instant, took ${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("retry constants", () => {
  test("MAX_RETRIES is 3", () => {
    assert.strictEqual(MAX_RETRIES, 3);
  });

  test("RETRY_BASE_MS is 1000", () => {
    assert.strictEqual(RETRY_BASE_MS, 1000);
  });
});

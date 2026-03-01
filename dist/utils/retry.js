/**
 * Retry utilities for API drivers.
 *
 * Shared between Anthropic and OpenAI drivers to avoid duplication.
 *
 * Configurable via environment variables:
 *   GRO_MAX_RETRIES     max retry attempts (default: 3)
 *   GRO_RETRY_BASE_MS   base delay in ms for exponential backoff (default: 1000)
 */
// Read at call time so --max-retries / --retry-base-ms (which set env vars) take effect
export const MAX_RETRIES = 3; // default — overridden at runtime via env
export const RETRY_BASE_MS = 1000; // default — overridden at runtime via env
function maxRetries() { return parseInt(process.env.GRO_MAX_RETRIES ?? String(MAX_RETRIES), 10); }
function retryBaseMs() { return parseInt(process.env.GRO_RETRY_BASE_MS ?? String(RETRY_BASE_MS), 10); }
/**
 * Check if an HTTP status code is retryable.
 * 429 = rate limited, 502/503 = upstream error, 529 = overloaded.
 */
export function isRetryable(status) {
    return status === 429 || status === 502 || status === 503 || status === 529;
}
/**
 * Calculate retry delay with exponential backoff + jitter.
 * Respects the Retry-After response header when present.
 * attempt 0 → base 1s + 0-0.5s jitter
 * attempt 1 → base 2s + 0-1s jitter
 * attempt 2 → base 4s + 0-2s jitter
 */
export function getMaxRetries() { return maxRetries(); }
const MAX_RETRY_DELAY_MS = 30_000; // Never wait more than 30s regardless of Retry-After header
export function retryDelay(attempt, retryAfterHeader) {
    if (retryAfterHeader) {
        const seconds = parseFloat(retryAfterHeader);
        if (!isNaN(seconds) && seconds > 0)
            return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    }
    const base = retryBaseMs() * Math.pow(2, attempt);
    const jitter = Math.random() * base * 0.5;
    return Math.min(base + jitter, MAX_RETRY_DELAY_MS);
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

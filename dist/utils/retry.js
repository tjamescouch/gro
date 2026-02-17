/**
 * Retry utilities for API drivers.
 *
 * Shared between Anthropic and OpenAI drivers to avoid duplication.
 */
export const MAX_RETRIES = 3;
export const RETRY_BASE_MS = 1000;
/**
 * Check if an HTTP status code is retryable.
 * 429 = rate limited, 502/503 = upstream error, 529 = overloaded.
 */
export function isRetryable(status) {
    return status === 429 || status === 502 || status === 503 || status === 529;
}
/**
 * Calculate retry delay with exponential backoff + jitter.
 * attempt 0 → base 1s + 0-0.5s jitter
 * attempt 1 → base 2s + 0-1s jitter
 * attempt 2 → base 4s + 0-2s jitter
 */
export function retryDelay(attempt) {
    const base = RETRY_BASE_MS * Math.pow(2, attempt);
    const jitter = Math.random() * base * 0.5;
    return base + jitter;
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

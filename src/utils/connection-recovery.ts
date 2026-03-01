/**
 * Connection recovery — indefinite retry loop for sustained outages.
 *
 * Wraps a function that may throw connection errors. When the inner
 * function fails with a connection-class error, retries with capped
 * exponential backoff (5s → 10s → 30s → 60s) until success or abort.
 *
 * The driver's own 3-retry logic handles brief blips (seconds).
 * This layer handles sustained outages (proxy down for minutes).
 * Non-connection errors (400, 401, API errors) pass through immediately.
 */

export interface RecoveryOptions {
  signal?: AbortSignal;
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
  initialDelayMs?: number;   // default: 5000
  maxDelayMs?: number;       // default: 60000
  backoffFactor?: number;    // default: 2
}

const CONNECTION_ERROR_RE =
  /fetch timeout|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|socket hang up|network error/i;

export function isConnectionError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (CONNECTION_ERROR_RE.test(msg)) return true;
  // Check cause chain
  const cause = (err as any)?.cause;
  if (cause && cause !== err) return isConnectionError(cause);
  // Check cause_message field (groError format)
  const causeMsg = (err as any)?.cause_message;
  if (typeof causeMsg === "string" && CONNECTION_ERROR_RE.test(causeMsg)) return true;
  return false;
}

export async function withConnectionRecovery<T>(
  fn: () => Promise<T>,
  opts: RecoveryOptions = {},
): Promise<T> {
  const {
    signal,
    onRetry,
    initialDelayMs = 5000,
    maxDelayMs = 60000,
    backoffFactor = 2,
  } = opts;

  let attempt = 0;
  let delay = initialDelayMs;

  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (!isConnectionError(err)) throw err;
      if (signal?.aborted) throw err;

      attempt++;
      const jitter = Math.random() * delay * 0.25;
      const effectiveDelay = Math.round(delay + jitter);

      if (onRetry) {
        onRetry(attempt, effectiveDelay, err instanceof Error ? err : new Error(String(err)));
      }

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, effectiveDelay);
        if (signal) {
          const onAbort = () => {
            clearTimeout(timer);
            reject(new Error("Connection recovery aborted"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });

      delay = Math.min(delay * backoffFactor, maxDelayMs);
    }
  }
}

/**
 * Structured error types for gro.
 *
 * All error boundaries should wrap errors using GroError instead of
 * stringifying with e.message. This preserves stack traces, enables
 * retry logic, and provides consistent logging fields.
 */

export type GroErrorKind =
  | "provider_error"
  | "tool_error"
  | "config_error"
  | "mcp_error"
  | "timeout_error"
  | "session_error";

export interface GroError extends Error {
  kind: GroErrorKind;
  provider?: string;
  model?: string;
  request_id?: string;
  retryable: boolean;
  latency_ms?: number;
  cause?: unknown;
}

/**
 * Create a GroError with structured fields.
 */
export function groError(
  kind: GroErrorKind,
  message: string,
  opts: {
    provider?: string;
    model?: string;
    request_id?: string;
    retryable?: boolean;
    latency_ms?: number;
    cause?: unknown;
  } = {},
): GroError {
  const err = new Error(message) as GroError;
  err.kind = kind;
  err.retryable = opts.retryable ?? false;
  if (opts.provider) err.provider = opts.provider;
  if (opts.model) err.model = opts.model;
  if (opts.request_id) err.request_id = opts.request_id;
  if (opts.latency_ms !== undefined) err.latency_ms = opts.latency_ms;
  if (opts.cause !== undefined) err.cause = opts.cause;
  return err;
}

/**
 * Normalize an unknown thrown value into an Error.
 * Handles strings, objects, nulls — the full JS throw spectrum.
 */
export function asError(e: unknown): Error {
  if (e instanceof Error) return e;
  if (typeof e === "string") return new Error(e);
  if (e === null || e === undefined) return new Error("Unknown error");
  try {
    return new Error(String(e));
  } catch {
    return new Error("Unknown error");
  }
}

/**
 * Check if an error is a GroError with structured fields.
 */
export function isGroError(e: unknown): e is GroError {
  return e instanceof Error && "kind" in e && "retryable" in e;
}

/**
 * Format a GroError for structured logging.
 * Returns a plain object suitable for JSON.stringify or structured loggers.
 */
export function errorLogFields(e: GroError): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    kind: e.kind,
    message: e.message,
    retryable: e.retryable,
  };
  if (e.provider) fields.provider = e.provider;
  if (e.model) fields.model = e.model;
  if (e.request_id) fields.request_id = e.request_id;
  if (e.latency_ms !== undefined) fields.latency_ms = e.latency_ms;
  if (e.cause) {
    const cause = asError(e.cause);
    fields.cause_message = cause.message;
    if (cause.stack) fields.cause_stack = cause.stack;
  }
  if (e.stack) fields.stack = e.stack;
  return fields;
}

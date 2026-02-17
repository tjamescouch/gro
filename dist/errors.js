/**
 * Structured error types for gro.
 *
 * All error boundaries should wrap errors using GroError instead of
 * stringifying with e.message. This preserves stack traces, enables
 * retry logic, and provides consistent logging fields.
 */
/**
 * Create a GroError with structured fields.
 */
export function groError(kind, message, opts = {}) {
    const err = new Error(message);
    err.kind = kind;
    err.retryable = opts.retryable ?? false;
    if (opts.provider)
        err.provider = opts.provider;
    if (opts.model)
        err.model = opts.model;
    if (opts.request_id)
        err.request_id = opts.request_id;
    if (opts.latency_ms !== undefined)
        err.latency_ms = opts.latency_ms;
    if (opts.cause !== undefined)
        err.cause = opts.cause;
    return err;
}
/**
 * Normalize an unknown thrown value into an Error.
 * Handles strings, objects, nulls — the full JS throw spectrum.
 */
export function asError(e) {
    if (e instanceof Error)
        return e;
    if (typeof e === "string")
        return new Error(e.slice(0, 1024));
    if (e === null || e === undefined)
        return new Error("Unknown error");
    try {
        const s = String(e);
        return new Error(s.length > 1024 ? s.slice(0, 1024) + "..." : s);
    }
    catch {
        return new Error("Unknown error (unstringifiable)");
    }
}
/**
 * Check if an error is a GroError with structured fields.
 */
export function isGroError(e) {
    return e instanceof Error && "kind" in e && "retryable" in e;
}
/**
 * Format a GroError for structured logging.
 * Returns a plain object suitable for JSON.stringify or structured loggers.
 */
export function errorLogFields(e) {
    const fields = {
        kind: e.kind,
        message: e.message,
        retryable: e.retryable,
    };
    if (e.provider)
        fields.provider = e.provider;
    if (e.model)
        fields.model = e.model;
    if (e.request_id)
        fields.request_id = e.request_id;
    if (e.latency_ms !== undefined)
        fields.latency_ms = e.latency_ms;
    if (e.cause) {
        const cause = asError(e.cause);
        fields.cause_message = cause.message;
        if (cause.stack)
            fields.cause_stack = cause.stack;
    }
    if (e.stack)
        fields.stack = e.stack;
    return fields;
}

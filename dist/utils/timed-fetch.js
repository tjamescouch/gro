import { asError } from "../errors.js";
/** Wrap fetch with timeout and location context for debugging. */
export async function timedFetch(url, init = {}) {
    const { timeoutMs, where, ...rest } = init;
    let controller = null;
    let timer = null;
    try {
        if (timeoutMs && timeoutMs > 0) {
            controller = new AbortController();
            rest.signal = controller.signal;
            timer = setTimeout(() => controller.abort(), timeoutMs);
        }
        return await fetch(url, rest);
    }
    catch (e) {
        const wrapped = asError(e);
        const isAbort = wrapped.name === "AbortError";
        const tag = isAbort ? "fetch timeout" : "fetch error";
        const err = new Error(`[${tag}] ${where ?? ""} ${url} -> ${wrapped.name}: ${wrapped.message}`);
        err.cause = e;
        throw err;
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}

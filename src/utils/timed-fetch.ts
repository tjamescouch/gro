/** Wrap fetch with timeout and location context for debugging. */
export async function timedFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number; where?: string } = {}
) {
  const { timeoutMs, where, ...rest } = init;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    if (timeoutMs && timeoutMs > 0) {
      controller = new AbortController();
      (rest as any).signal = controller.signal;
      timer = setTimeout(() => controller!.abort(), timeoutMs);
    }
    return await fetch(url, rest);
  } catch (e: any) {
    const err = new Error(
      `[fetch timeout] ${where ?? ""} ${url} -> ${e?.name || "Error"}: ${e?.message || e}`
    );
    (err as any).cause = e;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fire-and-forget HTTP POST to the personas LFS server.
 * Batches signals at ~60fps to avoid overwhelming the connection.
 */
import { Logger } from "../logger.js";
import type { LfsSignal } from "./signal-extractor.js";

export class LfsPoster {
  private url: string;
  private animateUrl: string;
  private queue: LfsSignal[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly BATCH_INTERVAL_MS = 16; // ~60fps

  constructor(serverUrl: string) {
    const base = serverUrl.replace(/\/+$/, "");
    this.url = base.includes("/api/signal") ? base : `${base}/api/signal`;
    this.animateUrl = `${base}/api/avatar/animate`;
  }

  /** Enqueue a signal for batched sending. */
  post(signal: LfsSignal): void {
    this.queue.push(signal);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.BATCH_INTERVAL_MS);
    }
  }

  /** Enqueue multiple signals. */
  postBatch(signals: LfsSignal[]): void {
    for (const s of signals) this.queue.push(s);
    if (!this.flushTimer && this.queue.length > 0) {
      this.flushTimer = setTimeout(() => this.flush(), this.BATCH_INTERVAL_MS);
    }
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0);
    try {
      await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch.length === 1 ? batch[0] : batch),
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // Fire and forget — don't crash gro if personas server is down
      Logger.debug("LFS post failed (server may be offline)");
    }
  }

  /** Fire-and-forget POST of avatar animation clips (clip name → weight). */
  postAnimation(clips: Record<string, number>): void {
    fetch(this.animateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clips }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {
      Logger.debug("LFS animate post failed (server may be offline)");
    });
  }

  /** Send a text chunk to the viewer. */
  postText(chunk: string): void {
    this.post({ type: "text", chunk } as any);
  }

  /** Send a text_control signal to mark response boundaries. */
  postTextControl(action: "start" | "end"): void {
    this.post({ type: "text_control", action } as any);
  }

  /** Flush remaining signals. Call at end of response. */
  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}

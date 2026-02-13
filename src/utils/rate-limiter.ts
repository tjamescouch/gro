type LimiterState = {
  nextAvailableMs: number;
  tail: Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

class RateLimiter {
  private states = new Map<string, LimiterState>();
  private readonly now: () => number;

  constructor(now?: () => number) {
    this.now =
      now ??
      (() =>
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now());
  }

  async limit(name: string, throughputPerSecond: number): Promise<void> {
    if (!Number.isFinite(throughputPerSecond) || throughputPerSecond <= 0) {
      throw new RangeError(
        `throughputPerSecond must be a positive finite number; got ${throughputPerSecond}`
      );
    }
    const key = name || "default";
    const state = this.getState(key);

    const waitPromise = state.tail.then(async () => {
      const intervalMs = 1000 / throughputPerSecond;
      const now = this.now();
      const scheduledAt = Math.max(now, state.nextAvailableMs);
      state.nextAvailableMs = scheduledAt + intervalMs;
      const delay = scheduledAt - now;
      if (delay > 0) await sleep(delay);
    });

    state.tail = waitPromise.catch(() => {});
    return waitPromise;
  }

  reset(name?: string): void {
    if (name) this.states.delete(name);
    else this.states.clear();
  }

  private getState(name: string): LimiterState {
    let s = this.states.get(name);
    if (!s) {
      s = { nextAvailableMs: this.now(), tail: Promise.resolve() };
      this.states.set(name, s);
    }
    return s;
  }
}

export const rateLimiter = new RateLimiter();

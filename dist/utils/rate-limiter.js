function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
class RateLimiter {
    constructor(now) {
        this.states = new Map();
        this.now =
            now ??
                (() => typeof performance !== "undefined" && typeof performance.now === "function"
                    ? performance.now()
                    : Date.now());
    }
    async limit(name, throughputPerSecond) {
        if (!Number.isFinite(throughputPerSecond) || throughputPerSecond <= 0) {
            throw new RangeError(`throughputPerSecond must be a positive finite number; got ${throughputPerSecond}`);
        }
        const key = name || "default";
        const state = this.getState(key);
        const waitPromise = state.tail.then(async () => {
            const intervalMs = 1000 / throughputPerSecond;
            const now = this.now();
            const scheduledAt = Math.max(now, state.nextAvailableMs);
            state.nextAvailableMs = scheduledAt + intervalMs;
            const delay = scheduledAt - now;
            if (delay > 0)
                await sleep(delay);
        });
        state.tail = waitPromise.catch(() => { });
        return waitPromise;
    }
    reset(name) {
        if (name)
            this.states.delete(name);
        else
            this.states.clear();
    }
    getState(name) {
        let s = this.states.get(name);
        if (!s) {
            s = { nextAvailableMs: this.now(), tail: Promise.resolve() };
            this.states.set(name, s);
        }
        return s;
    }
}
export const rateLimiter = new RateLimiter();

/**
 * TemporalSource — sensory channel that renders temporal position as progress bars.
 *
 * Five zoom levels, each a full-width bar spanning the grid:
 *   year    — position within 12 months
 *   month   — day of month / days in month
 *   week    — position within Mon–Sun
 *   day     — position within 24h
 *   session — elapsed within max session window
 *
 * Each bar = one row, full grid width, █ filled, ░ empty, label on right.
 * Pure visual — the agent reads position from bar length, not from numbers.
 */
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export class TemporalSource {
    constructor(config) {
        this.startTime = config?.sessionOrigin ?? Date.now();
        this.config = {
            barWidth: config?.barWidth ?? 44,
            maxSessionMs: config?.maxSessionMs ?? 2 * 60 * 60 * 1000,
        };
    }
    /** Update the session origin (e.g., after restoring a session). */
    setSessionOrigin(epochMs) {
        this.startTime = epochMs;
    }
    async poll() {
        return this.render();
    }
    destroy() { }
    render() {
        const now = new Date();
        const w = this.config.barWidth;
        const minutesInDay = now.getHours() * 60 + now.getMinutes();
        const dow = (now.getDay() + 6) % 7; // Monday=0
        const dom = now.getDate();
        const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const bars = [
            {
                frac: (now.getMonth() + dom / dim) / 12,
                label: `year ${MONTH_NAMES[now.getMonth()]}`,
            },
            {
                frac: dom / dim,
                label: `month ${dom}/${dim}`,
            },
            {
                frac: (dow + minutesInDay / (24 * 60)) / 7,
                label: `week ${DAY_NAMES[dow]}`,
            },
            {
                frac: minutesInDay / (24 * 60),
                label: `day ${Math.round((minutesInDay / (24 * 60)) * 100)}%`,
            },
            {
                frac: Math.min(1, (now.getTime() - this.startTime) / this.config.maxSessionMs),
                label: `session ${this.formatDuration(now.getTime() - this.startTime)}`,
            },
        ];
        const lines = [];
        for (const bar of bars) {
            const barWidth = Math.max(4, w - bar.label.length - 2);
            const filled = Math.round(Math.max(0, Math.min(1, bar.frac)) * barWidth);
            const empty = barWidth - filled;
            lines.push(`${"█".repeat(filled)}${"░".repeat(empty)}  ${bar.label}`);
        }
        return lines.join("\n");
    }
    /** Format a duration in ms to a compact human-readable string. */
    formatDuration(ms) {
        const s = Math.floor(ms / 1000);
        if (s < 60)
            return `${s}s`;
        const m = Math.floor(s / 60);
        if (m < 60)
            return `${m}m`;
        const h = Math.floor(m / 60);
        const rm = m % 60;
        return `${h}h${rm > 0 ? `${rm}m` : ""}`;
    }
}

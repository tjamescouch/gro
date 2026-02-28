/**
 * TemporalSource — sensory channel that renders temporal position as concentric rings.
 *
 * Five nested rings show where you are within each unit of time:
 *   outermost: year  — position within 12 months
 *   next:      month — day of month / days in month
 *   next:      week  — position within Mon–Sun
 *   next:      day   — position within 24h
 *   innermost: session — elapsed within max session window
 *
 * Each ring is a single row of fill characters, indented to create a visual
 * nesting effect. No prose — pure visual with cardinal labels.
 *
 * Adapts to the channel's grid width.
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
        const lines = [];
        const minutesInDay = now.getHours() * 60 + now.getMinutes();
        const dow = (now.getDay() + 6) % 7; // Monday=0
        const dom = now.getDate();
        const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const rings = [
            {
                indent: 0,
                frac: (now.getMonth() + dom / dim) / 12,
                label: MONTH_NAMES[now.getMonth()],
            },
            {
                indent: 2,
                frac: dom / dim,
                label: `${dom}/${dim}`,
            },
            {
                indent: 4,
                frac: (dow + minutesInDay / (24 * 60)) / 7,
                label: DAY_NAMES[dow],
            },
            {
                indent: 6,
                frac: minutesInDay / (24 * 60),
                label: `${Math.round((minutesInDay / (24 * 60)) * 100)}%`,
            },
            {
                indent: 8,
                frac: Math.min(1, (now.getTime() - this.startTime) / this.config.maxSessionMs),
                label: this.formatDuration(now.getTime() - this.startTime),
            },
        ];
        for (const ring of rings) {
            const barWidth = Math.max(4, w - ring.indent * 2 - ring.label.length - 2);
            const filled = Math.round(Math.max(0, Math.min(1, ring.frac)) * barWidth);
            const empty = barWidth - filled;
            const pad = " ".repeat(ring.indent);
            const bar = "▒".repeat(filled) + "░".repeat(empty);
            lines.push(`${pad}${bar}  ${ring.label}`);
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

/**
 * TemporalSource — sensory channel that renders temporal position as progress bars.
 *
 * Five zoom levels show where you are within each unit of time:
 *   session — elapsed within max session window
 *   day     — position within 24h
 *   week    — position within Mon–Sun
 *   month   — day of month / days in month
 *   year    — month position within 12
 *
 * Same visual language as context-map-source: ▒ = filled, ░ = empty.
 * A session gap shows up as a jump in the day/week bars — discontinuity
 * you can see rather than read.
 *
 * Target: under 120 tokens per render.
 */
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LABEL_WIDTH = 9; // "session" + 2 spaces
export class TemporalSource {
    constructor(config) {
        this.startTime = config?.sessionOrigin ?? Date.now();
        this.config = {
            barWidth: config?.barWidth ?? 32,
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
        // Session — elapsed / max window
        const elapsedMs = now.getTime() - this.startTime;
        const sessionFrac = Math.min(1, elapsedMs / this.config.maxSessionMs);
        lines.push(this.progressRow("session", sessionFrac, w, this.formatDuration(elapsedMs)));
        // Day — position within 24h
        const minutesInDay = now.getHours() * 60 + now.getMinutes();
        const dayFrac = minutesInDay / (24 * 60);
        lines.push(this.progressRow("day", dayFrac, w, `${Math.round(dayFrac * 100)}%`));
        // Week — position within Mon–Sun (Monday = 0)
        const dow = (now.getDay() + 6) % 7; // Monday=0, Sunday=6
        const weekFrac = (dow + minutesInDay / (24 * 60)) / 7;
        lines.push(this.progressRow("week", weekFrac, w, DAY_NAMES[dow]));
        // Month — day of month / days in month
        const dom = now.getDate();
        const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const monthFrac = dom / dim;
        lines.push(this.progressRow("month", monthFrac, w, `${dom}/${dim}`));
        // Year — month position within 12
        const yearFrac = (now.getMonth() + dom / dim) / 12;
        lines.push(this.progressRow("year", yearFrac, w, MONTH_NAMES[now.getMonth()]));
        return lines.join("\n");
    }
    /** Render a progress row: left-aligned label + ▒ fill + ░ empty + suffix. */
    progressRow(label, fraction, width, suffix) {
        const paddedLabel = label.padEnd(LABEL_WIDTH);
        const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
        const empty = width - filled;
        return `${paddedLabel}${"▒".repeat(filled)}${"░".repeat(empty)}  ${suffix}`;
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

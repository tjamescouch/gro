/**
 * TemporalSource — sensory channel that renders temporal context.
 *
 * Shows wall clock, session uptime, and time since last message per channel.
 * Addresses the temporal disorientation agents experience across restarts.
 *
 * Target: under 150 tokens per render.
 */
export class TemporalSource {
    constructor(config = {}) {
        this.lastMessageTimes = new Map();
        this.sessionStart = config.sessionStart ?? Date.now();
        this.lastRestart = config.lastRestart;
    }
    /** Record a message timestamp for a channel (call this when messages arrive). */
    recordMessage(channel, ts = Date.now()) {
        this.lastMessageTimes.set(channel, ts);
    }
    async poll() {
        return this.render();
    }
    destroy() {
        // No resources to clean up
    }
    render() {
        const now = Date.now();
        const lines = [];
        // Wall clock (UTC)
        const clock = new Date(now).toISOString().replace("T", " ").slice(0, 19) + " UTC";
        lines.push(`clock ${clock}`);
        // Session uptime
        lines.push(` uptime ${this.formatDuration(now - this.sessionStart)}`);
        // Time since last restart (if different from session start)
        if (this.lastRestart && this.lastRestart !== this.sessionStart) {
            lines.push(`restart ${this.formatDuration(now - this.lastRestart)} ago`);
        }
        // Per-channel staleness
        if (this.lastMessageTimes.size > 0) {
            for (const [channel, ts] of this.lastMessageTimes) {
                const age = this.formatDuration(now - ts);
                const label = channel.length > 10 ? channel.slice(0, 10) : channel;
                lines.push(` ${label.padStart(10)} last msg ${age} ago`);
            }
        }
        return lines.join("\n");
    }
    formatDuration(ms) {
        const s = Math.floor(ms / 1000);
        if (s < 60)
            return `${s}s`;
        const m = Math.floor(s / 60);
        if (m < 60)
            return `${m}m ${s % 60}s`;
        const h = Math.floor(m / 60);
        return `${h}h ${m % 60}m`;
    }
}

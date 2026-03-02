/**
 * ViolationsSource — sensory channel that renders violation tracking awareness.
 *
 * Uses ViolationTracker for count, breakdown, sleep status, and penalty factor.
 * Constructor accepts null for non-persistent mode; setTracker() allows late-binding.
 */
export class ViolationsSource {
    constructor(tracker) {
        this.tracker = tracker;
    }
    setTracker(tracker) {
        this.tracker = tracker;
    }
    async poll() {
        return this.render();
    }
    destroy() { }
    render() {
        if (!this.tracker) {
            return "  n/a (non-persistent)";
        }
        const stats = this.tracker.getStats();
        const sleeping = this.tracker.isSleeping();
        const lines = [];
        lines.push(`  total ${stats.total}`);
        if (stats.total > 0) {
            const parts = [];
            if (stats.byType.plain_text > 0)
                parts.push(`txt:${stats.byType.plain_text}`);
            if (stats.byType.idle > 0)
                parts.push(`idle:${stats.byType.idle}`);
            if (stats.byType.same_tool_loop > 0)
                parts.push(`loop:${stats.byType.same_tool_loop}`);
            if (stats.byType.context_pressure > 0)
                parts.push(`ctx:${stats.byType.context_pressure}`);
            lines.push(`  types ${parts.join(" ")}`);
            lines.push(`penalty x${stats.penaltyFactor.toFixed(1)}`);
        }
        if (sleeping) {
            lines.push(`  sleep ON`);
        }
        return lines.join("\n");
    }
}

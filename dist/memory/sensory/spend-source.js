/**
 * SpendSource — sensory channel that renders spend/cost awareness.
 *
 * Uses the SpendMeter singleton for session cost, model info, and token rates.
 */
export class SpendSource {
    constructor(meter) {
        this.meter = meter;
    }
    async poll() {
        return this.render();
    }
    destroy() { }
    render() {
        const cost = this.meter.cost();
        const tokens = this.meter.tokens;
        const lines = [];
        lines.push(`  cost $${cost.toFixed(4)}`);
        lines.push(`   tok ${this.fmtK(tokens.in)} in / ${this.fmtK(tokens.out)} out`);
        const last = this.meter.lastTurnMs;
        if (last > 0) {
            lines.push(` turn ${this.fmtDur(last)} | longest ${this.fmtDur(this.meter.longestTurnMs)} | avg ${this.fmtDur(this.meter.avgTurnMs)}`);
        }
        lines.push(`   hz ${this.meter.currentHorizon} cur / ${this.meter.maxHorizon} max (${this.meter.totalTurns} turns)`);
        return lines.join("\n");
    }
    fmtK(n) {
        if (n >= 1_000_000)
            return (n / 1_000_000).toFixed(1) + "M";
        if (n >= 1_000)
            return (n / 1_000).toFixed(1) + "K";
        return n.toFixed(0);
    }
    fmtDur(ms) {
        if (ms < 1000)
            return `${ms}ms`;
        return `${(ms / 1000).toFixed(1)}s`;
    }
}

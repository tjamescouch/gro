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
        lines.push(` total ${this.fmtK(tokens.in + tokens.out)}`);
        return lines.join("\n");
    }
    fmtK(n) {
        if (n >= 1_000_000)
            return (n / 1_000_000).toFixed(1) + "M";
        if (n >= 1_000)
            return (n / 1_000).toFixed(1) + "K";
        return n.toFixed(0);
    }
}

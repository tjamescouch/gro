/**
 * LFS Signal Extractor — converts token + logprobs + timing
 * into LLM-Face Streaming signals for avatar animation.
 */
// ── Grapheme-to-viseme mapping ──
const DIGRAPHS = {
    th: "TH", sh: "SH", ch: "CH", ee: "EE", oo: "OO",
    ou: "OW", ai: "EH", ea: "EE", ie: "EE", oi: "OW",
    ph: "FF", wh: "WW", ng: "NN", ck: "KK",
};
const CHARS = {
    a: "AA", e: "EH", i: "IH", o: "OW", u: "UH",
    b: "PP", c: "KK", d: "NN", f: "FF", g: "KK",
    h: "SIL", j: "CH", k: "KK", l: "LL", m: "PP",
    n: "NN", p: "PP", q: "KK", r: "RR", s: "SS",
    t: "NN", v: "FF", w: "WW", x: "KK", y: "YY", z: "SS",
};
function tokenToVisemes(token) {
    const visemes = [];
    const lower = token.toLowerCase();
    let i = 0;
    while (i < lower.length) {
        const ch = lower[i];
        if (/[\s.,!?;:\-"'()\n\t]/.test(ch)) {
            visemes.push("SIL");
            i++;
            continue;
        }
        // Try digraph
        if (i + 1 < lower.length) {
            const di = lower.slice(i, i + 2);
            if (DIGRAPHS[di]) {
                visemes.push(DIGRAPHS[di]);
                i += 2;
                continue;
            }
        }
        visemes.push(CHARS[ch] || "SIL");
        i++;
    }
    return visemes;
}
// ── Signal Extractor ──
export class SignalExtractor {
    constructor() {
        this.seq = 0;
        this.lastTokenTime = Date.now();
        this.prevConfidence = 0.85;
        this.prevEntropy = 0.1;
    }
    /**
     * Extract LFS signal(s) from a token emission.
     * Returns one signal per viseme in the token text.
     */
    extract(token, logprobs) {
        const now = Date.now();
        const dt = now - this.lastTokenTime;
        this.lastTokenTime = now;
        // Compute confidence from logprob
        let confidence = 0.85;
        let entropy = 0.1;
        if (logprobs) {
            confidence = Math.min(1, Math.max(0, Math.exp(logprobs.logprob)));
            if (logprobs.top_logprobs && logprobs.top_logprobs.length > 0) {
                let H = 0;
                for (const lp of logprobs.top_logprobs) {
                    const p = Math.exp(lp.logprob);
                    if (p > 0)
                        H -= p * Math.log(p);
                }
                const maxH = Math.log(logprobs.top_logprobs.length);
                entropy = maxH > 0 ? Math.min(1, H / maxH) : 0;
            }
        }
        const c_vel = +(confidence - this.prevConfidence).toFixed(3);
        const e_vel = +(entropy - this.prevEntropy).toFixed(3);
        this.prevConfidence = confidence;
        this.prevEntropy = entropy;
        const visemes = tokenToVisemes(token);
        if (visemes.length === 0)
            visemes.push("SIL");
        return visemes.map((v, i) => ({
            v,
            c: +confidence.toFixed(2),
            e: +entropy.toFixed(2),
            dt: i === 0 ? dt : Math.round(dt / visemes.length),
            seq: this.seq++,
            c_vel,
            e_vel,
        }));
    }
}

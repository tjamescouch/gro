/**
 * RandomSamplingFragmenter — age-biased stochastic sampling fragmenter.
 *
 * Instead of summarizing pages, this fragmenter randomly samples messages
 * with higher probability for recent messages. The sampling rate increases
 * with message age, preserving a sparse but representative view of the
 * conversation history.
 *
 * Algorithm:
 * - effectiveRate = sampleRate * (age / maxAge) ^ ageWeightExponent
 * - capped at 0.5 to avoid over-sampling
 * - older messages have higher sampling probability
 */
const DEFAULTS = {
    sampleRate: 0.2,
    ageWeightExponent: 1.5,
    minFragmentSize: 1,
    maxFragmentSize: 20,
};
export class RandomSamplingFragmenter {
    fragment(messages, config) {
        const cfg = { ...DEFAULTS, ...config };
        if (messages.length === 0)
            return [];
        // If messages fit in one fragment, return as-is
        if (messages.length <= cfg.maxFragmentSize) {
            return [{
                    messages,
                    metadata: {
                        preview: this.makePreview(messages),
                        position: 0,
                        count: messages.length,
                    },
                }];
        }
        // Perform age-biased stochastic sampling
        const maxAge = messages.length; // oldest message has age = length, newest = 1
        const sampled = [];
        for (let i = 0; i < messages.length; i++) {
            const age = messages.length - i; // older messages have higher age
            const normalizedAge = age / maxAge;
            const effectiveRate = Math.min(0.5, cfg.sampleRate * Math.pow(normalizedAge, cfg.ageWeightExponent));
            // Stochastic sampling: include message with probability effectiveRate
            if (Math.random() < effectiveRate) {
                sampled.push(messages[i]);
            }
        }
        // Ensure minimum fragment size
        if (sampled.length < cfg.minFragmentSize && messages.length > 0) {
            // Fall back to uniform sampling to meet minimum
            const step = Math.floor(messages.length / cfg.minFragmentSize);
            sampled.length = 0;
            for (let i = 0; i < messages.length; i += step) {
                sampled.push(messages[i]);
                if (sampled.length >= cfg.minFragmentSize)
                    break;
            }
        }
        // Split sampled messages into fragments of maxFragmentSize
        const fragments = [];
        for (let i = 0; i < sampled.length; i += cfg.maxFragmentSize) {
            const chunk = sampled.slice(i, i + cfg.maxFragmentSize);
            fragments.push({
                messages: chunk,
                metadata: {
                    preview: this.makePreview(chunk),
                    position: i,
                    count: chunk.length,
                },
            });
        }
        return fragments;
    }
    makePreview(messages) {
        if (messages.length === 0)
            return "";
        const first = messages[0];
        const content = String(first.content ?? "").slice(0, 80);
        return `${first.role}: ${content}${content.length > 80 ? "…" : ""}`;
    }
}

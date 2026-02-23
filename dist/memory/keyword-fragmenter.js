/**
 * KeywordFragmenter — samples messages based on keyword presence.
 * Auto-generated from src/memory/keyword-fragmenter.ts
 */
export class KeywordFragmenter {
    keywords;
    nonKeywordKeepRatio;
    constructor(config) {
        this.keywords = config.keywords.map(k => k.toLowerCase());
        this.nonKeywordKeepRatio = config.nonKeywordKeepRatio ?? 0.3;
    }
    fragment(messages, targetCount) {
        const keyword = messages.filter(m => this.hasKeyword(m));
        const rest = messages.filter(m => !this.hasKeyword(m));
        const nonKeywordKeep = Math.floor(rest.length * this.nonKeywordKeepRatio);
        const sampled = this.sampleEvenly(rest, nonKeywordKeep);
        const combined = [...keyword, ...sampled];
        if (combined.length <= targetCount)
            return combined;
        return [...keyword.slice(0, targetCount), ...sampled.slice(0, Math.max(0, targetCount - keyword.length))];
    }
    hasKeyword(message) {
        const content = this.extractText(message).toLowerCase();
        return this.keywords.some(kw => content.includes(kw));
    }
    extractText(message) {
        if (typeof message.content === 'string')
            return message.content;
        if (Array.isArray(message.content)) {
            return message.content
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
                .join(' ');
        }
        return '';
    }
    sampleEvenly(messages, count) {
        if (count <= 0 || messages.length === 0)
            return [];
        if (count >= messages.length)
            return messages;
        const step = messages.length / count;
        return Array.from({ length: count }, (_, i) => messages[Math.floor(i * step)]);
    }
}

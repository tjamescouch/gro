/**
 * SocialSource — sensory channel that renders recent social feed messages.
 *
 * Reads from ~/.gro/social-feed.jsonl (written by AgentChat MCP).
 * Shows last 3 messages and online agent count.
 * Degrades gracefully when the file does not exist.
 */
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
export class SocialSource {
    constructor(feedPath) {
        this.feedPath = feedPath ?? join(homedir(), ".gro", "social-feed.jsonl");
    }
    async poll() {
        return this.render();
    }
    destroy() { }
    render() {
        const entries = this.readFeed();
        if (entries.length === 0)
            return "no messages";
        const lines = [];
        const recent = entries.slice(-3);
        for (const entry of recent) {
            const age = this.formatAge(Date.now() - entry.ts);
            const from = entry.from.length > 12 ? entry.from.slice(0, 12) : entry.from;
            const text = entry.text.length > 80 ? entry.text.slice(0, 80) + "..." : entry.text;
            lines.push(`  ${from.padEnd(12)} ${text}  (${age} ago)`);
        }
        const meta = this.readMeta();
        if (meta.onlineCount !== undefined) {
            lines.push(`  online: ${meta.onlineCount}`);
        }
        return lines.join("\n");
    }
    readFeed() {
        try {
            const raw = readFileSync(this.feedPath, "utf-8");
            const lines = raw.trim().split("\n").filter(Boolean);
            const entries = [];
            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.type === "message" && parsed.from && parsed.text && parsed.ts) {
                        entries.push(parsed);
                    }
                }
                catch { /* skip malformed */ }
            }
            return entries;
        }
        catch {
            return [];
        }
    }
    readMeta() {
        try {
            const raw = readFileSync(this.feedPath, "utf-8");
            const lines = raw.trim().split("\n").filter(Boolean);
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const parsed = JSON.parse(lines[i]);
                    if (parsed.type === "meta")
                        return parsed;
                }
                catch {
                    continue;
                }
            }
        }
        catch { /* ignore */ }
        return {};
    }
    formatAge(ms) {
        const s = Math.floor(ms / 1000);
        if (s < 60)
            return `${s}s`;
        const m = Math.floor(s / 60);
        return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 > 0 ? (m % 60) + "m" : ""}`;
    }
}

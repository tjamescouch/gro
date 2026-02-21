/**
 * Memory Metrics — instrumentation for VirtualMemory performance
 *
 * Tracks:
 * - Page reference patterns (successful recalls vs. attempts)
 * - Eviction impact (how often evicted pages are re-referenced)
 * - Summary quality (page size pre/post-summarization)
 * - Lane-specific retention rates
 *
 * Use this data to tune eviction policy, summary prompts, and lane weights.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
export class MemoryMetricsCollector {
    constructor(sessionId, metricsPath) {
        this.pages = new Map();
        this.totalReferences = 0;
        this.successfulRecalls = 0;
        this.missedReferences = 0;
        this.sessionId = sessionId;
        this.metricsPath = metricsPath;
        this.load();
    }
    // ── Page lifecycle events ───────────────────────────────────────
    onPageCreated(pageId, lane, tokens) {
        this.pages.set(pageId, {
            pageId,
            lane,
            created: Date.now(),
            evicted: null,
            referencedCount: 0,
            lastReferenced: null,
            summarizedAt: null,
            originalTokens: tokens,
            summaryTokens: null,
            compressionRatio: null,
            reloadCount: 0,
        });
    }
    onPageEvicted(pageId) {
        const metrics = this.pages.get(pageId);
        if (!metrics)
            return;
        metrics.evicted = Date.now();
    }
    onPageSummarized(pageId, summaryTokens) {
        const metrics = this.pages.get(pageId);
        if (!metrics)
            return;
        metrics.summarizedAt = Date.now();
        metrics.summaryTokens = summaryTokens;
        metrics.compressionRatio = metrics.originalTokens / summaryTokens;
    }
    onPageReferenced(pageId, successful) {
        this.totalReferences++;
        const metrics = this.pages.get(pageId);
        if (!metrics) {
            // Reference to unknown page (likely very old, pre-instrumentation)
            this.missedReferences++;
            return;
        }
        if (successful) {
            this.successfulRecalls++;
            metrics.referencedCount++;
            metrics.lastReferenced = Date.now();
            // If page was evicted and now reloaded, count it
            if (metrics.evicted !== null) {
                metrics.reloadCount++;
            }
        }
        else {
            this.missedReferences++;
        }
    }
    // ── Analytics ───────────────────────────────────────────────────
    computeLaneMetrics() {
        const laneGroups = {};
        for (const metrics of this.pages.values()) {
            if (!laneGroups[metrics.lane]) {
                laneGroups[metrics.lane] = [];
            }
            laneGroups[metrics.lane].push(metrics);
        }
        const laneMetrics = {};
        for (const [lane, pages] of Object.entries(laneGroups)) {
            const evictedPages = pages.filter(p => p.evicted !== null);
            const referencedPages = pages.filter(p => p.referencedCount > 0);
            const retentionTimes = evictedPages.map(p => p.evicted - p.created);
            const avgRetentionTime = retentionTimes.length > 0
                ? retentionTimes.reduce((sum, t) => sum + t, 0) / retentionTimes.length
                : 0;
            const compressionRatios = pages
                .filter(p => p.compressionRatio !== null)
                .map(p => p.compressionRatio);
            const avgCompressionRatio = compressionRatios.length > 0
                ? compressionRatios.reduce((sum, r) => sum + r, 0) / compressionRatios.length
                : 0;
            const refRecallRate = evictedPages.length > 0
                ? referencedPages.filter(p => p.evicted !== null).length / evictedPages.length
                : 0;
            laneMetrics[lane] = {
                lane,
                totalPages: pages.length,
                totalEvictions: evictedPages.length,
                avgRetentionTime,
                refRecallRate,
                avgCompressionRatio,
            };
        }
        return laneMetrics;
    }
    snapshot() {
        const evictedPages = Array.from(this.pages.values()).filter(p => p.evicted !== null);
        const avgEvictionAge = evictedPages.length > 0
            ? evictedPages.reduce((sum, p) => sum + (p.evicted - p.created), 0) / evictedPages.length
            : 0;
        return {
            timestamp: Date.now(),
            sessionId: this.sessionId,
            pages: Array.from(this.pages.values()),
            lanes: this.computeLaneMetrics(),
            globalStats: {
                totalReferences: this.totalReferences,
                successfulRecalls: this.successfulRecalls,
                missedReferences: this.missedReferences,
                avgEvictionAge,
            },
        };
    }
    // ── Persistence ─────────────────────────────────────────────────
    save() {
        const snapshot = this.snapshot();
        writeFileSync(this.metricsPath, JSON.stringify(snapshot, null, 2));
    }
    load() {
        if (!existsSync(this.metricsPath))
            return;
        try {
            const data = JSON.parse(readFileSync(this.metricsPath, "utf-8"));
            // Restore page metrics
            for (const pageMetrics of data.pages) {
                this.pages.set(pageMetrics.pageId, pageMetrics);
            }
            // Restore global counters
            this.totalReferences = data.globalStats.totalReferences;
            this.successfulRecalls = data.globalStats.successfulRecalls;
            this.missedReferences = data.globalStats.missedReferences;
        }
        catch (err) {
            // Corrupted metrics file — start fresh
            console.warn(`[MemoryMetrics] Failed to load metrics: ${err}`);
        }
    }
    // ── Reporting ───────────────────────────────────────────────────
    generateReport() {
        const snapshot = this.snapshot();
        const lines = [];
        lines.push("# Memory Metrics Report");
        lines.push(`Session: ${this.sessionId}`);
        lines.push(`Generated: ${new Date(snapshot.timestamp).toISOString()}`);
        lines.push("");
        lines.push("## Global Stats");
        lines.push(`- Total references: ${snapshot.globalStats.totalReferences}`);
        lines.push(`- Successful recalls: ${snapshot.globalStats.successfulRecalls}`);
        lines.push(`- Missed references: ${snapshot.globalStats.missedReferences}`);
        lines.push(`- Recall success rate: ${(snapshot.globalStats.successfulRecalls / snapshot.globalStats.totalReferences * 100).toFixed(1)}%`);
        lines.push(`- Avg page lifetime before eviction: ${(snapshot.globalStats.avgEvictionAge / 1000 / 60).toFixed(1)} min`);
        lines.push("");
        lines.push("## Lane Metrics");
        for (const [lane, metrics] of Object.entries(snapshot.lanes)) {
            lines.push(`### ${lane}`);
            lines.push(`- Total pages: ${metrics.totalPages}`);
            lines.push(`- Evictions: ${metrics.totalEvictions}`);
            lines.push(`- Avg retention: ${(metrics.avgRetentionTime / 1000 / 60).toFixed(1)} min`);
            lines.push(`- Ref recall rate: ${(metrics.refRecallRate * 100).toFixed(1)}%`);
            lines.push(`- Avg compression: ${metrics.avgCompressionRatio.toFixed(2)}x`);
            lines.push("");
        }
        lines.push("## Top Referenced Pages");
        const topPages = snapshot.pages
            .filter(p => p.referencedCount > 0)
            .sort((a, b) => b.referencedCount - a.referencedCount)
            .slice(0, 10);
        for (const page of topPages) {
            lines.push(`- ${page.pageId} (${page.lane}): ${page.referencedCount} refs, ${page.reloadCount} reloads`);
        }
        lines.push("");
        lines.push("## Recommendations");
        // Analyze and suggest improvements
        const { lanes, globalStats } = snapshot;
        if (globalStats.missedReferences / globalStats.totalReferences > 0.3) {
            lines.push("⚠️  High miss rate (>30%). Consider:");
            lines.push("  - Increasing pageSlotTokens budget");
            lines.push("  - Pinning frequently-referenced pages");
        }
        for (const [lane, metrics] of Object.entries(lanes)) {
            if (metrics.avgCompressionRatio < 2.0) {
                lines.push(`⚠️  ${lane} lane: Low compression ratio (<2x). Summarizer may be too verbose.`);
            }
            if (metrics.refRecallRate > 0.5) {
                lines.push(`✓ ${lane} lane: High recall rate (${(metrics.refRecallRate * 100).toFixed(0)}%) — eviction policy is good.`);
            }
        }
        return lines.join("\n");
    }
}

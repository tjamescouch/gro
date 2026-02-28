/**
 * ContextMapSource — sensory channel that renders a detailed memory page viewer.
 *
 * Box-drawn 80-char-wide panel with six sections:
 *   1. HEADER   — page count, loaded count, fill bar, active token count
 *   2. LANES    — per-lane bars with emoji glyphs and token counts
 *   3. PAGE ROWS — pages grouped by time bucket with columns
 *   4. ANCHORS  — high-importance pages (maxImportance >= 0.8)
 *   5. SIZE HISTOGRAM — 4-bucket token distribution
 *   6. LOAD BUDGET — slot usage bar
 *
 * Drill-down filters (context:today, context:full, context:pg_id) render
 * detailed page info into the same box.
 */
import { topBorder, bottomBorder, sectionDivider, row, bar, lpad, rpad, IW } from "./box.js";
// --- Constants ---
/** Fill bar width in the header. */
const FILL_BAR_W = 27;
/** Lane bar width. */
const LANE_BAR_W = 20;
/** Max page rows per time bucket before truncation. */
const MAX_ROWS_PER_BUCKET = 11;
// --- Lane glyphs ---
const LANE_GLYPHS = {
    assistant: "🤖",
    user: "👤",
    system: "⚙️",
    tool: "🔧",
    mixed: "🔀",
};
function laneGlyph(lane) {
    return LANE_GLYPHS[lane] ?? "·";
}
function laneAbbr(lane) {
    if (lane === "assistant")
        return "asst";
    if (lane === "user")
        return "user";
    if (lane === "system")
        return "sys ";
    if (lane === "tool")
        return "tool";
    return "mix ";
}
// --- Time bucketing helpers ---
function timeBucket(createdAt, now) {
    const d = new Date(createdAt);
    const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
    if (diffDays <= 0)
        return "today";
    if (diffDays === 1)
        return "yesterday";
    return "older";
}
function bucketRank(bucket) {
    if (bucket === "today")
        return 0;
    if (bucket === "yesterday")
        return 1;
    return 100;
}
function timeRange(pages) {
    if (pages.length === 0)
        return "";
    const times = pages.map(p => new Date(p.createdAt));
    const earliest = new Date(Math.min(...times.map(t => t.getTime())));
    const latest = new Date(Math.max(...times.map(t => t.getTime())));
    return `${fmtHHMM(earliest)}–${fmtHHMM(latest)}`;
}
function fmtHHMM(d) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
}
function fmtTok(n) {
    if (n >= 1000)
        return (n / 1000).toFixed(1) + "k";
    return String(n);
}
export class ContextMapSource {
    constructor(memory, config) {
        /** One-shot filter for drill-down views. Cleared after next render. */
        this.filter = null;
        this.memory = memory;
        this.config = {
            maxChars: config?.maxChars ?? 0,
        };
    }
    /** Update the memory reference (e.g., after hot-swap). */
    setMemory(memory) {
        this.memory = memory;
    }
    /** Set a one-shot drill-down filter. Cleared after the next render. */
    setFilter(filter) {
        this.filter = filter;
    }
    /** Dynamically update the character budget. */
    setMaxChars(maxChars) {
        this.config.maxChars = maxChars;
    }
    async poll() {
        const result = this.render();
        if (this.filter)
            this.filter = null;
        return result;
    }
    destroy() { }
    render() {
        const stats = this.memory.getStats();
        return this.isVirtualStats(stats) ? this.renderVirtual(stats) : this.renderBasic(stats);
    }
    isVirtualStats(stats) {
        return stats.type === "virtual" || stats.type === "fragmentation" || stats.type === "hnsw" || stats.type === "perfect";
    }
    // --- Virtual Memory (full page viewer) ---
    renderVirtual(stats) {
        const totalBudget = stats.workingMemoryBudget + stats.pageSlotBudget;
        if (totalBudget === 0)
            return this.renderBasic(stats);
        const totalUsed = stats.systemTokens + stats.pageSlotUsed + stats.workingMemoryUsed;
        const pages = stats.pageDigest ?? [];
        const lines = [];
        // --- Check for drill-down first ---
        const filter = this.filter;
        if (filter && this.isPageIdFilter(filter, pages)) {
            const page = pages.find(p => p.id === filter);
            if (page) {
                lines.push(topBorder());
                lines.push(row(` CONTEXT  page detail`));
                lines.push(sectionDivider(`PAGE ${page.id}`));
                lines.push(...this.renderSinglePage(page, pages.length, stats.pagesLoaded));
                lines.push(row(` reset: view('context')`));
                lines.push(bottomBorder());
                return lines.join("\n");
            }
        }
        if (filter && (this.isTimeBucketFilter(filter) || filter === "full")) {
            lines.push(topBorder());
            lines.push(row(` CONTEXT  drill-down: ${filter}`));
            lines.push(sectionDivider(filter.toUpperCase()));
            lines.push(...this.renderDrillDown(pages, filter));
            lines.push(row(` reset: view('context')`));
            lines.push(bottomBorder());
            return lines.join("\n");
        }
        // === SECTION 1: HEADER ===
        const fillFrac = totalBudget > 0 ? totalUsed / totalBudget : 0;
        const fillBar = bar(fillFrac, FILL_BAR_W);
        const activeTokens = stats.pageSlotUsed + stats.workingMemoryUsed;
        const activeTokStr = fmtTok(activeTokens);
        const hdrLeft = ` PAGES  ${lpad(String(pages.length), 3)} total  ${lpad(String(stats.pagesLoaded), 2)} loaded  `;
        const hdrRight = `  ${activeTokStr} tok active `;
        const hdrMid = fillBar;
        lines.push(topBorder());
        lines.push(row(hdrLeft + hdrMid + rpad(hdrRight, IW - hdrLeft.length - hdrMid.length)));
        // === SECTION 2: LANES ===
        lines.push(sectionDivider("LANES"));
        this.renderLanes(stats, pages, lines);
        // === SECTION 3: PAGE ROWS ===
        this.renderPageRows(pages, lines);
        // === SECTION 4: ANCHORS ===
        const anchors = pages.filter(p => p.maxImportance >= 0.8);
        if (anchors.length > 0) {
            lines.push(sectionDivider("ANCHORS — marked @@important@@"));
            for (const p of anchors.slice(0, 6)) {
                const d = new Date(p.createdAt);
                const snippet = this.compactSummary(p.summary, p.label, 38);
                const inner = `  ${rpad(p.id, 12)}  ${laneGlyph(p.lane)}  ${fmtHHMM(d)}  ★  "${snippet}"`;
                lines.push(row(inner));
            }
            if (anchors.length > 6) {
                lines.push(row(`  [+${anchors.length - 6} more anchors]`));
            }
        }
        // === SECTION 5: SIZE HISTOGRAM ===
        lines.push(sectionDivider("SIZE HISTOGRAM"));
        this.renderHistogram(pages, lines);
        // === SECTION 6: LOAD BUDGET ===
        lines.push(sectionDivider("LOAD BUDGET"));
        this.renderLoadBudget(stats, lines);
        lines.push(bottomBorder());
        return lines.join("\n");
    }
    // --- Section 2: Lane bars ---
    renderLanes(stats, pages, lines) {
        // Aggregate tokens per lane from pages
        const laneTotals = { assistant: 0, user: 0, system: 0, tool: 0 };
        for (const p of pages) {
            const l = p.lane === "mixed" ? "assistant" : p.lane;
            if (l in laneTotals) {
                laneTotals[l] += p.tokens;
            }
            else {
                laneTotals["assistant"] += p.tokens;
            }
        }
        // Also fold in buffer lane stats
        for (const lane of stats.lanes) {
            if (lane.role in laneTotals) {
                laneTotals[lane.role] += lane.tokens;
            }
        }
        const maxTok = Math.max(1, ...Object.values(laneTotals));
        // Two lanes per row
        const laneOrder = [["assistant", "user"], ["system", "tool"]];
        for (const [l1, l2] of laneOrder) {
            const t1 = laneTotals[l1] ?? 0;
            const t2 = laneTotals[l2] ?? 0;
            const b1 = bar(t1 / maxTok, LANE_BAR_W);
            const b2 = bar(t2 / maxTok, LANE_BAR_W);
            const g1 = laneGlyph(l1);
            const g2 = laneGlyph(l2);
            const a1 = laneAbbr(l1);
            const a2 = laneAbbr(l2);
            const s1 = rpad(fmtTok(t1), 5);
            const s2 = rpad(fmtTok(t2), 5);
            // Layout: `  🤖asst ████...░░░░  4.9k   👤user ████...░░░░  4.4k   `
            const inner = `  ${g1}${a1} ${b1}  ${s1}   ${g2}${a2} ${b2}  ${s2}`;
            lines.push(row(inner));
        }
    }
    // --- Section 3: Page rows by time bucket ---
    renderPageRows(pages, lines) {
        const now = new Date();
        // Group by time bucket
        const buckets = new Map();
        const bucketOrder = [];
        for (const p of pages) {
            const bucket = timeBucket(p.createdAt, now);
            if (!buckets.has(bucket)) {
                buckets.set(bucket, []);
                bucketOrder.push(bucket);
            }
            buckets.get(bucket).push(p);
        }
        bucketOrder.sort((a, b) => bucketRank(a) - bucketRank(b));
        for (const bucket of bucketOrder) {
            const items = buckets.get(bucket);
            const range = timeRange(items);
            const bucketLabel = range
                ? `${bucket.toUpperCase()} ${range}`
                : bucket.toUpperCase();
            lines.push(sectionDivider(bucketLabel));
            // Column header
            lines.push(row("  ID           LANE  TIME   MSGS  TOKS   STATUS  SNIPPET"));
            lines.push(row("  " + "─".repeat(75)));
            const shown = items.slice(0, MAX_ROWS_PER_BUCKET);
            for (const p of shown) {
                lines.push(this.renderPageRow(p));
                const sumLine = this.renderSummaryLine(p);
                if (sumLine)
                    lines.push(sumLine);
            }
            if (items.length > MAX_ROWS_PER_BUCKET) {
                lines.push(row(`  [+${items.length - MAX_ROWS_PER_BUCKET} more pages]`));
            }
        }
        if (pages.length === 0) {
            lines.push(sectionDivider("PAGES"));
            lines.push(row("  (no pages)"));
        }
    }
    renderPageRow(p) {
        const idShort = rpad(p.id.length > 12 ? p.id.slice(0, 12) : p.id, 12);
        const glyph = laneGlyph(p.lane);
        const d = new Date(p.createdAt);
        const time = fmtHHMM(d);
        const msgs = lpad(String(p.messageCount ?? 0), 4);
        const toks = lpad(fmtTok(p.tokens), 5) + "t";
        let status;
        if (p.pinned)
            status = rpad("📌 pin", 8);
        else if (p.loaded)
            status = rpad("█ live", 8);
        else
            status = rpad("░ dark", 8);
        // Snippet — remaining space after fixed columns
        // Cols: 2 + 12 + 2 + glyph(2) + 2 + 5 + 3 + 4 + 2 + 6 + 3 + 8 + 2 = ~51 → snippet gets ~25 chars
        const snippet = this.compactSummary(p.summary, p.label, 23);
        const snippetStr = `"${snippet}"`;
        const inner = `  ${idShort}  ${glyph}   ${time}  ${msgs}  ${toks}  ${status} ${snippetStr}`;
        return row(inner);
    }
    /** Render an inline summary line under a page row. Returns null if no summary. */
    renderSummaryLine(p) {
        if (!p.summary)
            return null;
        // Strip boilerplate prefixes
        let s = p.summary;
        s = s.replace(/^\[Summary of \d+ messages:[^\]]*\]?\s*/i, "");
        s = s.replace(/^\[Pending summary:[^\]]*\]?\s*/i, "");
        s = s.replace(/^\.{3}\s*/, "");
        s = s.trim();
        if (!s || s.length < 3)
            return null;
        // Prefix: `   └ ` = 5 chars. Max summary = IW - 5 = 73 chars.
        const maxLen = IW - 5;
        const clipped = s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
        return row(`   └ ${clipped}`);
    }
    // --- Section 5: Size histogram ---
    renderHistogram(pages, lines) {
        if (pages.length === 0) {
            lines.push(row("  (no pages)"));
            return;
        }
        const maxTokens = Math.max(...pages.map(p => p.tokens));
        const buckets = [
            { label: "<100", test: (t) => t < 100, desc: "tiny — sys/status" },
            { label: "<1000", test: (t) => t >= 100 && t < 1000, desc: "small — summaries" },
            { label: "<5000", test: (t) => t >= 1000 && t < 5000, desc: "medium — working" },
            { label: String(maxTokens), test: (t) => t >= 5000, desc: "MAX — dense output" },
        ];
        const counts = buckets.map(b => ({
            ...b,
            count: pages.filter(p => b.test(p.tokens)).length,
        }));
        const maxCount = Math.max(1, ...counts.map(c => c.count));
        for (const c of counts) {
            const lbl = lpad(c.label, 6);
            const barStr = bar(c.count / maxCount, 20);
            const cntStr = rpad(`${c.count} pages`, 10);
            const desc = `(${c.desc})`;
            lines.push(row(`  ${lbl}  ${barStr}  ${cntStr} ${desc}`));
        }
    }
    // --- Section 6: Load budget ---
    renderLoadBudget(stats, lines) {
        const budget = stats.pageSlotBudget;
        const used = stats.pageSlotUsed;
        const usedFrac = budget > 0 ? used / budget : 0;
        const freeFrac = 1 - usedFrac;
        const usedBar = bar(usedFrac, 20);
        const freeBar = bar(freeFrac, 20);
        const usedStr = `${fmtTok(used)}/${fmtTok(budget)} used`;
        const freeStr = `budget free`;
        lines.push(row(`  slots: ${usedBar}  ${rpad(usedStr, 16)} ${freeBar}  ${freeStr}`));
    }
    // --- Single page drill-down ---
    renderSinglePage(page, totalPages, loadedCount) {
        const lines = [];
        lines.push(row(`  page: ${page.id}`));
        lines.push(row(`  tokens: ${fmtTok(page.tokens)}   messages: ${page.messageCount}   lane: ${page.lane}`));
        const status = page.loaded ? "loaded *" : page.pinned ? "pinned" : "unloaded";
        lines.push(row(`  status: ${status}   importance: ${page.maxImportance.toFixed(2)}`));
        lines.push(row(`  created: ${page.createdAt}`));
        const summary = this.compactSummary(page.summary, page.label, 68);
        lines.push(row(`  "${summary}"`));
        if (page.loaded) {
            lines.push(row(`  unload: unref('${page.id}')`));
        }
        else {
            lines.push(row(`  load: ref('${page.id}')`));
        }
        return lines;
    }
    // --- Time-bucket drill-down ---
    renderDrillDown(pages, filter) {
        const now = new Date();
        const lines = [];
        const buckets = new Map();
        const bucketOrder = [];
        for (const p of pages) {
            const bucket = timeBucket(p.createdAt, now);
            if (!buckets.has(bucket)) {
                buckets.set(bucket, []);
                bucketOrder.push(bucket);
            }
            buckets.get(bucket).push(p);
        }
        bucketOrder.sort((a, b) => bucketRank(a) - bucketRank(b));
        if (filter === "full") {
            for (const bucket of bucketOrder) {
                const items = buckets.get(bucket);
                lines.push(row(` ${bucket} (${items.length}):`));
                for (const p of items) {
                    lines.push(this.renderPageRow(p));
                    const sumLine = this.renderSummaryLine(p);
                    if (sumLine)
                        lines.push(sumLine);
                }
            }
        }
        else {
            for (const bucket of bucketOrder) {
                const items = buckets.get(bucket);
                if (bucket === filter) {
                    lines.push(row(` ${bucket} (${items.length}):`));
                    for (const p of items) {
                        lines.push(this.renderPageRow(p));
                        const sumLine = this.renderSummaryLine(p);
                        if (sumLine)
                            lines.push(sumLine);
                    }
                }
                else {
                    lines.push(row(` ${bucket} (${items.length})`));
                }
            }
        }
        return lines;
    }
    // --- Basic Memory (fallback) ---
    renderBasic(stats) {
        const lines = [];
        const usedK = (stats.totalTokensEstimate / 1000).toFixed(0);
        lines.push(topBorder());
        lines.push(row(` MEMORY  ${usedK}K  ${stats.totalMessages} msgs`));
        lines.push(bottomBorder());
        return lines.join("\n");
    }
    // --- Helpers ---
    compactSummary(summary, label, maxLen = 40) {
        let s = summary;
        s = s.replace(/^\[Summary of \d+ messages:[^\]]*\]?\s*/i, "");
        s = s.replace(/^\[Pending summary:[^\]]*\]?\s*/i, "");
        s = s.replace(/^\.{3}\s*/, "");
        if (!s || s.length < 3) {
            s = label.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s*-?\s*/g, "").trim();
            if (!s)
                s = label;
        }
        return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
    }
    isTimeBucketFilter(filter) {
        return filter === "today" || filter === "yest" || filter === "yesterday" ||
            filter === "older" || /^\d+d$/.test(filter) || /^\d+d ago$/.test(filter);
    }
    isPageIdFilter(filter, pages) {
        return pages.some(p => p.id === filter);
    }
}

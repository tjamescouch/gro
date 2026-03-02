/**
 * TemporalSource — sensory channel that renders temporal position.
 *
 * Box-drawn 80-char-wide panel with five zoom levels:
 *   YEAR  — month within 12
 *   MONTH — day within month
 *   WEEK  — day within Mon–Sun
 *   DAY   — hour within 24h
 *   SESS  — elapsed session time + turn counter
 *
 * Each zoom (except SESS) has: bar line, axis line, cursor (▲) line.
 * Pure visual — the agent reads position from bar shape and labels.
 */
import { topBorder, bottomBorder, divider, row, bar, lpad, IW } from "./box.js";
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_ABBR = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
/** Bar width in characters (all time bars use same width). */
const BAR_W = 50;
/** Prefix width: ` LABEL ` = 7 chars. */
const PREFIX_W = 7;
/** Suffix width: remaining chars after prefix + bar = 78 - 7 - 50 = 21. */
const SUFFIX_W = 21;
export class TemporalSource {
    constructor(config) {
        this.turnCount = 0;
        this.maxTurns = 60;
        this.startTime = config?.sessionOrigin ?? Date.now();
        this.maxSessionMs = config?.maxSessionMs ?? 2 * 60 * 60 * 1000;
    }
    /** Update the session origin (e.g., after restoring a session). */
    setSessionOrigin(epochMs) {
        this.startTime = epochMs;
    }
    /** Update current turn count (called from main loop). */
    setTurnCount(turn) {
        this.turnCount = turn;
    }
    /** Update max turns for the turn bar scale. */
    setMaxTurns(max) {
        this.maxTurns = max;
    }
    async poll() {
        return this.render();
    }
    destroy() { }
    render() {
        const now = new Date();
        const lines = [];
        // --- Header ---
        const dayName = DAY_NAMES[(now.getDay() + 6) % 7];
        const dateStr = `${dayName} ${now.getDate()} ${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()}`;
        const timeStr = `${lpad(String(now.getHours()), 2).replace(/ /g, "0")}:${lpad(String(now.getMinutes()), 2).replace(/ /g, "0")}`;
        const headerRight = `${dateStr}  ${timeStr}`;
        const headerInner = ` TIME` + " ".repeat(Math.max(1, IW - 5 - headerRight.length)) + headerRight;
        lines.push(topBorder());
        lines.push(row(headerInner));
        // --- YEAR ---
        const monthFrac = (now.getMonth() + now.getDate() / this.daysInMonth(now)) / 12;
        const yearLabel = `${MONTH_NAMES[now.getMonth()]}/${12}`;
        lines.push(divider());
        lines.push(this.barRow("YEAR", monthFrac, yearLabel));
        lines.push(this.axisRow(MONTH_ABBR, BAR_W));
        lines.push(this.cursorRow(monthFrac));
        // --- MONTH ---
        const dom = now.getDate();
        const dim = this.daysInMonth(now);
        const monthDayFrac = dom / dim;
        const monthLabel = `${dom}/${dim}`;
        lines.push(divider());
        lines.push(this.barRow("MONTH", monthDayFrac, monthLabel));
        lines.push(this.monthAxisRow(dim));
        lines.push(this.cursorRow(monthDayFrac));
        // --- WEEK ---
        const dow = (now.getDay() + 6) % 7; // Monday=0
        const minutesInDay = now.getHours() * 60 + now.getMinutes();
        const weekFrac = (dow + minutesInDay / 1440) / 7;
        const weekLabel = `${DAY_NAMES[dow]}/7`;
        lines.push(divider());
        lines.push(this.barRow("WEEK", weekFrac, weekLabel));
        lines.push(this.axisRow(["M", "T", "W", "T", "F", "S", "S"], BAR_W));
        lines.push(this.cursorRow(weekFrac));
        // --- DAY ---
        const dayFrac = minutesInDay / 1440;
        const hourStr = `${lpad(String(now.getHours()), 2).replace(/ /g, "0")}h`;
        const dayLabel = `${hourStr}/24h`;
        lines.push(divider());
        lines.push(this.barRow("DAY", dayFrac, dayLabel));
        lines.push(this.dayAxisRow());
        lines.push(this.cursorRow(dayFrac));
        // --- SESS + TURN ---
        const elapsedMs = now.getTime() - this.startTime;
        const sessFrac = Math.min(1, elapsedMs / this.maxSessionMs);
        const sessLabel = this.formatDuration(elapsedMs);
        const turnFrac = Math.min(1, this.turnCount / Math.max(1, this.maxTurns));
        const turnLabel = `t:${this.turnCount}`;
        lines.push(divider());
        lines.push(this.barRow("SESS", sessFrac, sessLabel));
        lines.push(this.barRow("TURN", turnFrac, turnLabel));
        lines.push(bottomBorder());
        return lines.join("\n");
    }
    /** Render a bar row: ` LABEL <bar>  value     ` */
    barRow(label, frac, value) {
        const prefix = (" " + label).padEnd(PREFIX_W);
        const barStr = bar(frac, BAR_W);
        const suffix = ("  " + value).padEnd(SUFFIX_W);
        return row(prefix + barStr + suffix);
    }
    /**
     * Render an axis row with labels evenly spaced across the bar area.
     * Format: 7-char prefix (spaces) + axis labels + padding to IW.
     * Labels may extend past BAR_W into the suffix area.
     */
    axisRow(labels, barWidth) {
        const prefix = " ".repeat(PREFIX_W);
        const totalInner = IW - PREFIX_W; // remaining chars after prefix
        const chars = new Array(totalInner).fill(" ");
        if (labels.length > 1) {
            const gap = barWidth / labels.length;
            for (let i = 0; i < labels.length; i++) {
                const pos = Math.round(i * gap);
                const lbl = labels[i];
                for (let j = 0; j < lbl.length && pos + j < totalInner; j++) {
                    chars[pos + j] = lbl[j];
                }
            }
        }
        return row(prefix + chars.join(""));
    }
    /** Month axis: show key day numbers across the bar. */
    monthAxisRow(daysInMonth) {
        const prefix = " ".repeat(PREFIX_W);
        const totalInner = IW - PREFIX_W;
        const ticks = [1, 5, 10, 15, 20, 25, daysInMonth];
        const chars = new Array(totalInner).fill(" ");
        for (const tick of ticks) {
            const pos = Math.round(((tick - 1) / (daysInMonth - 1)) * (BAR_W - 1));
            const label = String(tick);
            for (let j = 0; j < label.length && pos + j < totalInner; j++) {
                chars[pos + j] = label[j];
            }
        }
        return row(prefix + chars.join(""));
    }
    /** Day axis: 00  06  12  18  24 spaced across BAR_W. */
    dayAxisRow() {
        const prefix = " ".repeat(PREFIX_W);
        const totalInner = IW - PREFIX_W;
        const ticks = [0, 6, 12, 18, 24];
        const chars = new Array(totalInner).fill(" ");
        for (const tick of ticks) {
            const pos = Math.round((tick / 24) * (BAR_W - 1));
            const label = lpad(String(tick), 2).replace(/ /g, "0");
            for (let j = 0; j < label.length && pos + j < totalInner; j++) {
                chars[pos + j] = label[j];
            }
        }
        return row(prefix + chars.join(""));
    }
    /** Cursor row: ▲ positioned at the fraction point under the bar. */
    cursorRow(frac) {
        const prefix = " ".repeat(PREFIX_W);
        const totalInner = IW - PREFIX_W;
        const pos = Math.round(Math.max(0, Math.min(1, frac)) * (BAR_W - 1));
        const cursorLine = " ".repeat(pos) + "▲";
        return row(prefix + cursorLine.padEnd(totalInner));
    }
    daysInMonth(date) {
        return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    }
    /** Format a duration in ms to a compact human-readable string. */
    formatDuration(ms) {
        const s = Math.floor(ms / 1000);
        if (s < 60)
            return `${s}s`;
        const m = Math.floor(s / 60);
        if (m < 60)
            return `${m}m`;
        const h = Math.floor(m / 60);
        const rm = m % 60;
        return `${h}h${rm > 0 ? `${rm}m` : ""}`;
    }
}

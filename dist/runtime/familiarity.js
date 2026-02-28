/**
 * FamiliarityTracker — tracks how well the agent knows its current working context.
 *
 * Every time the agent reads a file, greps a path, or refs a page, that resource's
 * familiarity score increases. Each turn, all scores decay. The agent sees the top
 * entries in the sensory buffer and can skip redundant reads.
 *
 * Scores approach 1.0 asymptotically on repeated access and decay toward 0.0
 * without re-access. This is a sensor, not a lock — the agent decides whether
 * to re-read based on the score.
 */
import { basename } from "node:path";
export class FamiliarityTracker {
    constructor(opts) {
        this.scores = new Map();
        this.labels = new Map();
        this.decayRate = opts?.decayRate ?? 0.9;
        this.boostFactor = opts?.boostFactor ?? 0.4;
        this.maxEntries = opts?.maxEntries ?? 200;
        this.pruneThreshold = opts?.pruneThreshold ?? 0.05;
    }
    /** Record an access to a resource. Score climbs asymptotically toward 1.0. */
    touch(resourceId) {
        if (!resourceId)
            return;
        const current = this.scores.get(resourceId) ?? 0;
        // Asymptotic climb: score += (1 - score) * boost
        this.scores.set(resourceId, current + (1 - current) * this.boostFactor);
        // Cache display label
        if (!this.labels.has(resourceId)) {
            this.labels.set(resourceId, makeLabel(resourceId));
        }
        // Enforce max entries (prune lowest scores)
        if (this.scores.size > this.maxEntries) {
            this.prune(this.pruneThreshold);
            // If still over, prune harder
            if (this.scores.size > this.maxEntries) {
                const sorted = [...this.scores.entries()].sort((a, b) => a[1] - b[1]);
                const toRemove = sorted.slice(0, this.scores.size - this.maxEntries);
                for (const [id] of toRemove) {
                    this.scores.delete(id);
                    this.labels.delete(id);
                }
            }
        }
    }
    /** Decay all scores. Call once per turn. */
    decay() {
        for (const [id, score] of this.scores) {
            const decayed = score * this.decayRate;
            if (decayed < this.pruneThreshold) {
                this.scores.delete(id);
                this.labels.delete(id);
            }
            else {
                this.scores.set(id, decayed);
            }
        }
    }
    /** Get familiarity for a specific resource. */
    get(resourceId) {
        return this.scores.get(resourceId) ?? 0;
    }
    /** Get top N most-familiar resources for display. */
    top(n = 8) {
        const entries = [];
        for (const [id, score] of this.scores) {
            entries.push({ id, label: this.labels.get(id) ?? id, score });
        }
        entries.sort((a, b) => b.score - a.score);
        return entries.slice(0, n);
    }
    /** Remove entries below threshold. */
    prune(threshold) {
        const t = threshold ?? this.pruneThreshold;
        for (const [id, score] of this.scores) {
            if (score < t) {
                this.scores.delete(id);
                this.labels.delete(id);
            }
        }
    }
    /** Number of tracked resources. */
    get size() {
        return this.scores.size;
    }
}
/** Extract a short display label from a resource identifier. */
function makeLabel(resourceId) {
    if (resourceId.startsWith("page:")) {
        return resourceId.slice(5); // strip "page:" prefix
    }
    // For file paths, use basename
    const base = basename(resourceId);
    return base || resourceId;
}

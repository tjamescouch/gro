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

export interface FamiliarityEntry {
  id: string;        // full resource identifier (path or page:id)
  label: string;     // short display name (basename or page id)
  score: number;     // 0.0–1.0
}

export class FamiliarityTracker {
  private scores = new Map<string, number>();
  private labels = new Map<string, string>();
  private readonly decayRate: number;
  private readonly boostFactor: number;
  private readonly maxEntries: number;
  private readonly pruneThreshold: number;

  constructor(opts?: {
    decayRate?: number;       // multiplier per decay() call (default 0.9)
    boostFactor?: number;     // per-touch climb rate (default 0.4)
    maxEntries?: number;      // cap on tracked resources (default 200)
    pruneThreshold?: number;  // auto-prune below this score (default 0.05)
  }) {
    this.decayRate = opts?.decayRate ?? 0.9;
    this.boostFactor = opts?.boostFactor ?? 0.4;
    this.maxEntries = opts?.maxEntries ?? 200;
    this.pruneThreshold = opts?.pruneThreshold ?? 0.05;
  }

  /** Record an access to a resource. Score climbs asymptotically toward 1.0. */
  touch(resourceId: string): void {
    if (!resourceId) return;
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
  decay(): void {
    for (const [id, score] of this.scores) {
      const decayed = score * this.decayRate;
      if (decayed < this.pruneThreshold) {
        this.scores.delete(id);
        this.labels.delete(id);
      } else {
        this.scores.set(id, decayed);
      }
    }
  }

  /** Get familiarity for a specific resource. */
  get(resourceId: string): number {
    return this.scores.get(resourceId) ?? 0;
  }

  /** Get top N most-familiar resources for display. */
  top(n = 8): FamiliarityEntry[] {
    const entries: FamiliarityEntry[] = [];
    for (const [id, score] of this.scores) {
      entries.push({ id, label: this.labels.get(id) ?? id, score });
    }
    entries.sort((a, b) => b.score - a.score);
    return entries.slice(0, n);
  }

  /** Remove entries below threshold. */
  prune(threshold?: number): void {
    const t = threshold ?? this.pruneThreshold;
    for (const [id, score] of this.scores) {
      if (score < t) {
        this.scores.delete(id);
        this.labels.delete(id);
      }
    }
  }

  /** Number of tracked resources. */
  get size(): number {
    return this.scores.size;
  }

  /** Capture state for warm state transfer. */
  snapshot(): { scores: Record<string, number>; labels: Record<string, string> } {
    return {
      scores: Object.fromEntries(this.scores),
      labels: Object.fromEntries(this.labels),
    };
  }

  /** Restore state from a warm state snapshot. */
  restore(snap: { scores: Record<string, number>; labels: Record<string, string> }): void {
    this.scores = new Map(Object.entries(snap.scores));
    this.labels = new Map(Object.entries(snap.labels));
  }
}

/** Extract a short display label from a resource identifier. */
function makeLabel(resourceId: string): string {
  if (resourceId.startsWith("page:")) {
    return resourceId.slice(5); // strip "page:" prefix
  }
  // For file paths, use basename
  const base = basename(resourceId);
  return base || resourceId;
}

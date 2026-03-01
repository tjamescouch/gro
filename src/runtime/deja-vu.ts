/**
 * DejaVuTracker — detects when the agent repeats actions it already performed.
 *
 * Maintains a rolling window of recent tool call signatures (tool name + args hash).
 * When a new tool call matches a recent one, returns the previous result summary
 * so the sensory buffer can warn: "You ran this 3x already, last result was..."
 *
 * This is a sensor, not a lock. The agent may have legitimate reasons to repeat
 * a command (file may have changed, different expectations). The warning surfaces
 * awareness so the agent can self-correct.
 */

import { createHash } from "node:crypto";

export interface ActionSignature {
  key: string;             // toolName:argsHash
  toolName: string;
  argsSnippet: string;     // first 80 chars of args for display
  resultPreview: string;   // first 120 chars of result
  turn: number;            // turn number of last execution
  count: number;           // times seen this session
}

export class DejaVuTracker {
  private history = new Map<string, ActionSignature>();
  private insertOrder: string[] = [];  // for FIFO eviction
  private readonly windowSize: number;
  private readonly minCountForWarning: number;

  constructor(opts?: {
    windowSize?: number;         // max tracked signatures (default 100)
    minCountForWarning?: number; // minimum repeats to surface (default 2)
  }) {
    this.windowSize = opts?.windowSize ?? 100;
    this.minCountForWarning = opts?.minCountForWarning ?? 2;
  }

  /**
   * Record a tool call. Returns the ActionSignature if this is a repeat
   * (count >= minCountForWarning), null otherwise.
   */
  record(
    toolName: string,
    args: Record<string, any>,
    result: string,
    turn: number,
  ): ActionSignature | null {
    const argsHash = hashArgs(args);
    const key = `${toolName}:${argsHash}`;

    const existing = this.history.get(key);
    if (existing) {
      existing.count++;
      existing.turn = turn;
      existing.resultPreview = result.slice(0, 120).replace(/\n/g, " ");
      return existing.count >= this.minCountForWarning ? existing : null;
    }

    // New entry
    const sig: ActionSignature = {
      key,
      toolName,
      argsSnippet: makeArgsSnippet(toolName, args),
      resultPreview: result.slice(0, 120).replace(/\n/g, " "),
      turn,
      count: 1,
    };

    this.history.set(key, sig);
    this.insertOrder.push(key);

    // Evict oldest entries if over window
    while (this.insertOrder.length > this.windowSize) {
      const oldKey = this.insertOrder.shift()!;
      this.history.delete(oldKey);
    }

    return null;
  }

  /** Get all active deja vu warnings (count >= threshold). */
  warnings(): ActionSignature[] {
    const result: ActionSignature[] = [];
    for (const sig of this.history.values()) {
      if (sig.count >= this.minCountForWarning) {
        result.push(sig);
      }
    }
    // Sort by count descending, then by turn descending
    result.sort((a, b) => b.count - a.count || b.turn - a.turn);
    return result;
  }

  /** Get the single most urgent warning for compact display. */
  topWarning(): ActionSignature | null {
    const w = this.warnings();
    return w.length > 0 ? w[0] : null;
  }

  /** Number of tracked signatures. */
  get size(): number {
    return this.history.size;
  }

  /** Capture state for warm state transfer. */
  snapshot(): { history: Record<string, ActionSignature>; insertOrder: string[] } {
    return {
      history: Object.fromEntries(this.history),
      insertOrder: [...this.insertOrder],
    };
  }

  /** Restore state from a warm state snapshot. */
  restore(snap: { history: Record<string, ActionSignature>; insertOrder: string[] }): void {
    this.history = new Map(Object.entries(snap.history));
    this.insertOrder = [...snap.insertOrder];
  }
}

/** Hash tool args to an 8-char hex string for dedup matching. */
function hashArgs(args: Record<string, any>): string {
  // Sort keys for deterministic hashing
  const sorted = JSON.stringify(args, Object.keys(args).sort());
  return createHash("sha256").update(sorted).digest("hex").slice(0, 8);
}

/** Create a human-readable snippet of tool args for display. */
function makeArgsSnippet(toolName: string, args: Record<string, any>): string {
  if ((toolName === "shell" || toolName === "Bash") && args.command) {
    const cmd = String(args.command);
    return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
  }
  if ((toolName === "Read" || toolName === "read") && (args.file_path || args.path)) {
    return String(args.file_path ?? args.path);
  }
  if (toolName === "Grep" && args.pattern) {
    const path = args.path ? ` in ${args.path}` : "";
    const pat = String(args.pattern);
    return `/${pat.length > 30 ? pat.slice(0, 27) + "..." : pat}/${path}`;
  }
  if (toolName === "Glob" && args.pattern) {
    return String(args.pattern);
  }
  // Generic: first key=value pair
  const entries = Object.entries(args);
  if (entries.length === 0) return "(no args)";
  const [k, v] = entries[0];
  const vs = typeof v === "string" ? v : JSON.stringify(v);
  const snippet = `${k}=${vs.length > 40 ? vs.slice(0, 37) + "..." : vs}`;
  return snippet;
}

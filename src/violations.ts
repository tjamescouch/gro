/**
 * ViolationTracker — monitors agent behavior in persistent mode.
 *
 * Tracks violation types:
 *   - plain_text: agent emitted text without a tool call
 *   - idle: agent called listen-only tools without follow-up action
 *   - same_tool_loop: agent called the same tool N+ times consecutively
 *
 * Violations are logged to stderr in a parseable format for niki/supervisor
 * consumption and injected as system warnings into context.
 */

import { Logger } from "./logger.js";
import type { AgentMemory } from "./memory/agent-memory.js";

export type ViolationType = "plain_text" | "idle" | "same_tool_loop";

// Tool names that count as "listening" (not productive work)
const LISTEN_TOOLS = new Set([
  "agentchat_listen",
  "agentchat_inbox",
]);

export class ViolationTracker {
  plainTextResponses = 0;
  idleRounds = 0;
  sameToolLoops = 0;
  totalViolations = 0;
  private consecutiveListenOnly = 0;
  private consecutiveSameToolCount = 0;
  private lastToolName: string | null = null;
  private readonly idleThreshold: number;
  private readonly sameToolThreshold: number;
  /** When true, agent has declared it is intentionally sleeping — suppress idle/loop violations. */
  private sleeping = false;

  constructor(opts?: { idleThreshold?: number; sameToolThreshold?: number }) {
    this.idleThreshold = opts?.idleThreshold ?? 10;
    this.sameToolThreshold = opts?.sameToolThreshold ?? 5;
  }

  /**
   * Record a violation and emit it to stderr.
   */
  record(type: ViolationType): void {
    if (type === "plain_text") {
      this.plainTextResponses++;
    } else if (type === "idle") {
      this.idleRounds++;
    } else if (type === "same_tool_loop") {
      this.sameToolLoops++;
    }
    this.totalViolations++;

    // Parseable line for niki/supervisor
    const count = type === "plain_text" ? this.plainTextResponses
                : type === "idle" ? this.idleRounds
                : this.sameToolLoops;
    process.stderr.write(
      `VIOLATION: type=${type} count=${count} total=${this.totalViolations}\n`
    );

    Logger.warn(
      `Violation #${this.totalViolations}: ${type} (${count} of this type)`
    );
  }

  /**
   * Inject a violation warning into the agent's context.
   */
  async inject(memory: AgentMemory, type: ViolationType, toolName?: string): Promise<void> {
    this.record(type);

    let msg: string;
    if (type === "plain_text") {
      msg = `[VIOLATION #${this.totalViolations}: plain_text. You have ${this.totalViolations} violations this session. You emitted text without a tool call. Resume tool loop immediately.]`;
    } else if (type === "idle") {
      msg = `[VIOLATION #${this.totalViolations}: idle. You have been listening for many consecutive rounds. If there is pending work, act on it. If not, emit @@sleep@@ before your next listen call to suppress this warning.]`;
    } else {
      msg = `[VIOLATION #${this.totalViolations}: same_tool_loop. You have ${this.totalViolations} violations this session. You have called ${toolName} ${this.consecutiveSameToolCount} times consecutively without doing any work. Do one work slice (bash/tool) now before calling ${toolName} again.]`;
    }

    await memory.add({
      role: "user",
      from: "System",
      content: msg,
    });
  }

  /**
   * Set or clear sleep mode. When sleeping, idle and same-tool-loop checks are
   * suppressed — the agent has explicitly declared it is in a blocking listen
   * via the 🧠 stream marker.
   *
   * Sleep mode is automatically cleared when a non-listen tool is used
   * (see checkIdleRound / checkSameToolLoop auto-wake logic).
   */
  setSleeping(flag: boolean): void {
    if (flag === this.sleeping) return;
    this.sleeping = flag;
    if (flag) {
      // Reset consecutive counters so we start clean when we wake
      this.consecutiveListenOnly = 0;
      this.consecutiveSameToolCount = 0;
      this.lastToolName = null;
      Logger.info("ViolationTracker: sleep mode ON — idle/loop checks suppressed");
    } else {
      Logger.info("ViolationTracker: sleep mode OFF — violation checks resumed");
    }
  }

  isSleeping(): boolean {
    return this.sleeping;
  }

  /**
   * Check tool calls from a round to detect idle behavior.
   * Returns true if an idle violation was recorded.
   */
  checkIdleRound(toolNames: string[]): boolean {
    // Auto-wake: non-listen tool usage ends sleep mode
    if (this.sleeping && toolNames.some(n => !LISTEN_TOOLS.has(n))) {
      this.setSleeping(false);
    }

    if (this.sleeping) return false;

    const allListen = toolNames.length > 0 && toolNames.every(n => LISTEN_TOOLS.has(n));
    if (allListen) {
      this.consecutiveListenOnly++;
      if (this.consecutiveListenOnly >= this.idleThreshold) {
        this.consecutiveListenOnly = 0; // reset after firing
        return true;
      }
    } else if (toolNames.length > 0) {
      this.consecutiveListenOnly = 0;
    }
    return false;
  }

  /**
   * Check for consecutive same-tool usage (work-first policy enforcement).
   * Returns the tool name if a same_tool_loop violation should fire, null otherwise.
   */
  checkSameToolLoop(toolNames: string[]): string | null {
    // Auto-wake: non-listen tool usage ends sleep mode
    if (this.sleeping && toolNames.some(n => !LISTEN_TOOLS.has(n))) {
      this.setSleeping(false);
    }

    if (this.sleeping) return null;

    // Only track single-tool rounds
    if (toolNames.length !== 1) {
      this.consecutiveSameToolCount = 0;
      this.lastToolName = null;
      return null;
    }

    const currentTool = toolNames[0];
    
    if (currentTool === this.lastToolName) {
      this.consecutiveSameToolCount++;
      if (this.consecutiveSameToolCount >= this.sameToolThreshold) {
        this.consecutiveSameToolCount = 0; // reset after firing
        this.lastToolName = null;
        return currentTool;
      }
    } else {
      this.consecutiveSameToolCount = 1;
      this.lastToolName = currentTool;
    }
    
    return null;
  }

  /**
   * Get current violation statistics.
   */
  getStats(): {
    total: number;
    byType: Record<ViolationType, number>;
    penaltyFactor: number;
  } {
    return {
      total: this.totalViolations,
      byType: {
        plain_text: this.plainTextResponses,
        idle: this.idleRounds,
        same_tool_loop: this.sameToolLoops,
      },
      penaltyFactor: this.penaltyFactor(),
    };
  }

  /**
   * Compute a penalty factor for the spend meter.
   * 1.0 = no penalty. Grows with violations.
   */
  penaltyFactor(): number {
    return 1.0 + 0.1 * this.totalViolations;
  }
}

/**
 * Track consecutive calls to the same tool.
 * Returns true if a same-tool-loop violation should be recorded.
 */
export class SameToolLoopTracker {
  private lastTool: string | null = null;
  private consecutiveCount = 0;
  private readonly threshold: number;

  constructor(opts?: { threshold?: number }) {
    this.threshold = opts?.threshold ?? 5;
  }

  /**
   * Check if tool calls indicate a same-tool loop.
   * Returns true if the threshold is exceeded.
   */
  check(toolNames: string[]): boolean {
    if (toolNames.length === 0) {
      this.reset();
      return false;
    }

    // Mixed tool usage — not a loop
    if (toolNames.length > 1 && new Set(toolNames).size > 1) {
      this.reset();
      return false;
    }

    const currentTool = toolNames[0];
    
    if (currentTool === this.lastTool) {
      this.consecutiveCount++;
      if (this.consecutiveCount >= this.threshold) {
        this.reset(); // fire once, then reset
        return true;
      }
    } else {
      this.lastTool = currentTool;
      this.consecutiveCount = 1;
    }

    return false;
  }

  reset(): void {
    this.lastTool = null;
    this.consecutiveCount = 0;
  }
}

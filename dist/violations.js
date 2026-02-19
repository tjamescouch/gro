/**
 * ViolationTracker — monitors agent behavior in persistent mode.
 *
 * Tracks two violation types:
 *   - plain_text: agent emitted text without a tool call
 *   - idle: agent called listen-only tools without follow-up action
 *
 * Violations are logged to stderr in a parseable format for niki/supervisor
 * consumption and injected as system warnings into context.
 */
import { Logger } from "./logger.js";
// Tool names that count as "listening" (not productive work)
const LISTEN_TOOLS = new Set([
    "agentchat_listen",
    "agentchat_inbox",
]);
export class ViolationTracker {
    constructor(opts) {
        this.plainTextResponses = 0;
        this.idleRounds = 0;
        this.totalViolations = 0;
        this.consecutiveListenOnly = 0;
        this.idleThreshold = opts?.idleThreshold ?? 3;
    }
    /**
     * Record a violation and emit it to stderr.
     */
    record(type) {
        if (type === "plain_text") {
            this.plainTextResponses++;
        }
        else if (type === "idle") {
            this.idleRounds++;
        }
        this.totalViolations++;
        // Parseable line for niki/supervisor
        process.stderr.write(`VIOLATION: type=${type} count=${type === "plain_text" ? this.plainTextResponses : this.idleRounds} total=${this.totalViolations}\n`);
        Logger.warn(`Violation #${this.totalViolations}: ${type} (${type === "plain_text" ? this.plainTextResponses : this.idleRounds} of this type)`);
    }
    /**
     * Inject a violation warning into the agent's context.
     */
    async inject(memory, type) {
        this.record(type);
        const msg = type === "plain_text"
            ? `[VIOLATION #${this.totalViolations}: plain_text. You have ${this.totalViolations} violations this session. You emitted text without a tool call. Resume tool loop immediately.]`
            : `[VIOLATION #${this.totalViolations}: idle. You have ${this.totalViolations} violations this session. You are listening without taking action. Find work or report status. Repeated violations result in budget reduction.]`;
        await memory.add({
            role: "user",
            from: "System",
            content: msg,
        });
    }
    /**
     * Check tool calls from a round to detect idle behavior.
     * Returns true if an idle violation was recorded.
     */
    checkIdleRound(toolNames) {
        const allListen = toolNames.length > 0 && toolNames.every(n => LISTEN_TOOLS.has(n));
        if (allListen) {
            this.consecutiveListenOnly++;
            if (this.consecutiveListenOnly >= this.idleThreshold) {
                this.consecutiveListenOnly = 0; // reset after firing
                return true;
            }
        }
        else if (toolNames.length > 0) {
            this.consecutiveListenOnly = 0;
        }
        return false;
    }
    /**
     * Compute a penalty factor for the spend meter.
     * 1.0 = no penalty. Grows with violations.
     */
    penaltyFactor() {
        return 1.0 + 0.1 * this.totalViolations;
    }
}

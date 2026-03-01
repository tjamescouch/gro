/**
 * ViolationTracker — monitors agent behavior in persistent mode.
 *
 * Tracks violation types:
 *   - plain_text: agent emitted text without a tool call
 *   - idle: agent called listen-only tools without follow-up action
 *   - same_tool_loop: agent called the same tool N+ times consecutively
 *   - read_only_drift: agent spent many rounds reading without any writes
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
// Tool names that count as "writing" — state-changing operations
const WRITE_TOOLS = new Set([
    "Write", "Edit", "apply_patch", "agentpatch", "write_self",
    "edit_source", "write_source", "export_changes", "NotebookEdit",
]);
export class ViolationTracker {
    constructor(opts) {
        this.plainTextResponses = 0;
        this.idleRounds = 0;
        this.sameToolLoops = 0;
        this.contextPressures = 0;
        this.readOnlyDrifts = 0;
        this.totalViolations = 0;
        this.consecutiveListenOnly = 0;
        this.consecutiveSameToolCount = 0;
        this.consecutiveContextPressure = 0;
        this.consecutiveReadOnlyRounds = 0;
        this.lastToolName = null;
        /** When true, agent has declared it is intentionally sleeping — suppress idle/loop violations. */
        this.sleeping = false;
        this.idleThreshold = opts?.idleThreshold ?? 10;
        this.sameToolThreshold = opts?.sameToolThreshold ?? 5;
        this.readOnlyDriftThreshold = opts?.readOnlyDriftThreshold ?? 10;
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
        else if (type === "same_tool_loop") {
            this.sameToolLoops++;
        }
        else if (type === "context_pressure") {
            this.contextPressures++;
        }
        else if (type === "read_only_drift") {
            this.readOnlyDrifts++;
        }
        this.totalViolations++;
        // Parseable line for niki/supervisor
        const count = type === "plain_text" ? this.plainTextResponses
            : type === "idle" ? this.idleRounds
                : type === "context_pressure" ? this.contextPressures
                    : type === "read_only_drift" ? this.readOnlyDrifts
                        : this.sameToolLoops;
        process.stderr.write(`VIOLATION: type=${type} count=${count} total=${this.totalViolations}\n`);
        Logger.warn(`Violation #${this.totalViolations}: ${type} (${count} of this type)`);
    }
    /**
     * Inject a violation warning into the agent's context.
     */
    async inject(memory, type, toolName) {
        this.record(type);
        let msg;
        if (type === "plain_text") {
            msg = `[VIOLATION #${this.totalViolations}: plain_text. You have ${this.totalViolations} violations this session. You emitted text without a tool call. Resume tool loop immediately.]`;
        }
        else if (type === "idle") {
            msg = `[VIOLATION #${this.totalViolations}: idle. You have been listening for many consecutive rounds. If there is pending work, act on it. If not, emit @@sleep@@ before your next listen call to suppress this warning.]`;
        }
        else if (type === "context_pressure") {
            msg = `[VIOLATION #${this.totalViolations}: context_pressure. Context usage is HIGH for ${this.consecutiveContextPressure} consecutive rounds with no remediation. You MUST act now: emit @@max-context('200k')@@ to expand budget, or call compact_context to free space. Runtime controls are autonomous — no permission needed.]`;
        }
        else if (type === "read_only_drift") {
            msg = `[VIOLATION #${this.totalViolations}: read_only_drift. You have spent ${this.readOnlyDriftThreshold}+ consecutive rounds reading without writing. You are in a read-only investigation loop. STOP reading and ACT: write code, apply a patch, or explain to the user why you cannot proceed. Reading more of the same files will not help.]`;
        }
        else {
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
    setSleeping(flag) {
        if (flag === this.sleeping)
            return;
        this.sleeping = flag;
        if (flag) {
            // Reset consecutive counters so we start clean when we wake
            this.consecutiveListenOnly = 0;
            this.consecutiveSameToolCount = 0;
            this.lastToolName = null;
            Logger.info("ViolationTracker: sleep mode ON — idle/loop checks suppressed");
        }
        else {
            Logger.info("ViolationTracker: sleep mode OFF — violation checks resumed");
        }
    }
    isSleeping() {
        return this.sleeping;
    }
    /**
     * Check tool calls from a round to detect idle behavior.
     * Returns true if an idle violation was recorded.
     */
    checkIdleRound(toolNames) {
        // Auto-wake: non-listen tool usage ends sleep mode
        if (this.sleeping && toolNames.some(n => !LISTEN_TOOLS.has(n))) {
            this.setSleeping(false);
        }
        if (this.sleeping)
            return false;
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
     * Check for consecutive same-tool usage (work-first policy enforcement).
     * Returns the tool name if a same_tool_loop violation should fire, null otherwise.
     */
    checkSameToolLoop(toolNames) {
        // Auto-wake: non-listen tool usage ends sleep mode
        if (this.sleeping && toolNames.some(n => !LISTEN_TOOLS.has(n))) {
            this.setSleeping(false);
        }
        if (this.sleeping)
            return null;
        if (toolNames.length === 0) {
            this.consecutiveSameToolCount = 0;
            this.lastToolName = null;
            return null;
        }
        // Check if all tools in this round are the same (handles both single and multi-call rounds)
        const uniqueTools = new Set(toolNames);
        if (uniqueTools.size > 1) {
            // Mixed tool usage — not a loop
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
        }
        else {
            this.consecutiveSameToolCount = 1;
            this.lastToolName = currentTool;
        }
        return null;
    }
    /**
     * Check if context pressure is sustained without remediation.
     * Call each round with the current memory usage ratio and whether the agent
     * took any remediation action (compact_context, max-context marker, etc.).
     * Returns true if a context_pressure violation should fire.
     */
    checkContextPressure(usageRatio, highRatio, remediated) {
        if (this.sleeping)
            return false;
        if (remediated) {
            this.consecutiveContextPressure = 0;
            return false;
        }
        if (usageRatio > highRatio) {
            this.consecutiveContextPressure++;
            if (this.consecutiveContextPressure >= 3) {
                this.consecutiveContextPressure = 0; // reset after firing
                return true;
            }
        }
        else {
            this.consecutiveContextPressure = 0;
        }
        return false;
    }
    /**
     * Check for sustained read-only rounds (no file writes or patches).
     * Detects investigation loops where the agent reads endlessly without acting.
     * Returns true if a read_only_drift violation should fire.
     */
    checkReadOnlyDrift(toolNames) {
        if (this.sleeping)
            return false;
        if (toolNames.length === 0)
            return false;
        const hasWrite = toolNames.some(n => WRITE_TOOLS.has(n));
        if (hasWrite) {
            this.consecutiveReadOnlyRounds = 0;
            return false;
        }
        this.consecutiveReadOnlyRounds++;
        if (this.consecutiveReadOnlyRounds >= this.readOnlyDriftThreshold) {
            this.consecutiveReadOnlyRounds = 0; // reset after firing (can fire again)
            return true;
        }
        return false;
    }
    /**
     * Get current violation statistics.
     */
    getStats() {
        return {
            total: this.totalViolations,
            byType: {
                plain_text: this.plainTextResponses,
                idle: this.idleRounds,
                same_tool_loop: this.sameToolLoops,
                context_pressure: this.contextPressures,
                read_only_drift: this.readOnlyDrifts,
            },
            penaltyFactor: this.penaltyFactor(),
        };
    }
    /**
     * Compute a penalty factor for the spend meter.
     * 1.0 = no penalty. Grows with violations.
     */
    penaltyFactor() {
        return 1.0 + 0.1 * this.totalViolations;
    }
    /** Capture counters for warm state transfer. */
    snapshot() {
        return {
            plainTextResponses: this.plainTextResponses,
            idleRounds: this.idleRounds,
            sameToolLoops: this.sameToolLoops,
            contextPressures: this.contextPressures,
            readOnlyDrifts: this.readOnlyDrifts,
            totalViolations: this.totalViolations,
            sleeping: this.sleeping,
        };
    }
    /** Restore counters from a warm state snapshot. */
    restore(snap) {
        this.plainTextResponses = snap.plainTextResponses;
        this.idleRounds = snap.idleRounds;
        this.sameToolLoops = snap.sameToolLoops;
        this.contextPressures = snap.contextPressures;
        this.readOnlyDrifts = snap.readOnlyDrifts ?? 0;
        this.totalViolations = snap.totalViolations;
        this.sleeping = snap.sleeping;
    }
}
/**
 * Detect repetitive thinking loops where the model repeats the same phrase
 * many times in its reasoning tokens. This wastes tokens and indicates
 * degenerate behavior under context pressure.
 *
 * Feed thinking tokens via addToken(). Returns true when a loop is detected.
 */
export class ThinkingLoopDetector {
    constructor(opts) {
        this.buffer = "";
        this.charsSinceCheck = 0;
        this._detected = false;
        this.windowSize = opts?.windowSize ?? 2000;
        this.phraseLen = opts?.phraseLen ?? 80;
        this.repeatThreshold = opts?.repeatThreshold ?? 3;
        this.checkInterval = opts?.checkInterval ?? 200;
    }
    /** Feed a thinking token. Returns true if a repetitive loop is detected. */
    addToken(text) {
        if (this._detected)
            return true; // Already detected, keep returning true
        this.buffer += text;
        if (this.buffer.length > this.windowSize) {
            this.buffer = this.buffer.slice(-this.windowSize);
        }
        this.charsSinceCheck += text.length;
        if (this.charsSinceCheck >= this.checkInterval) {
            this.charsSinceCheck = 0;
            if (this.detectLoop()) {
                this._detected = true;
                return true;
            }
        }
        return false;
    }
    /** Whether a loop was detected in this session. */
    get detected() { return this._detected; }
    /** Reset state for a new generation attempt. */
    reset() {
        this.buffer = "";
        this.charsSinceCheck = 0;
        this._detected = false;
    }
    detectLoop() {
        if (this.buffer.length < this.phraseLen * this.repeatThreshold)
            return false;
        // Extract the last phraseLen chars as candidate phrase
        const candidate = this.buffer.slice(-this.phraseLen);
        // Count how many times this phrase appears in the buffer
        let count = 0;
        let pos = 0;
        while (true) {
            const idx = this.buffer.indexOf(candidate, pos);
            if (idx === -1)
                break;
            count++;
            if (count >= this.repeatThreshold)
                return true;
            pos = idx + 1;
        }
        return false;
    }
}

/**
 * TaskSource — sensory channel that renders the agent's current task state.
 *
 * Provides awareness of:
 *   - Active claimed task (what am I working on?)
 *   - Task queue (what's next?)
 *   - Blockers
 *   - Last completed task
 *
 * State is persisted to ~/.gro/tasks.json so it survives restarts.
 * Agents update task state via the task-state tool or direct API calls.
 *
 * Output targets under 150 tokens per render.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Logger } from "../logger.js";
const DEFAULT_STATE = {
    active: null,
    queue: [],
    blockers: [],
    lastCompleted: null,
    updatedAt: Date.now(),
};
export class TaskSource {
    constructor(statePath) {
        const groDir = join(homedir(), ".gro");
        mkdirSync(groDir, { recursive: true });
        this.statePath = statePath ?? join(groDir, "tasks.json");
        this.state = this.load();
    }
    load() {
        try {
            const raw = readFileSync(this.statePath, "utf-8");
            return { ...DEFAULT_STATE, ...JSON.parse(raw) };
        }
        catch {
            return { ...DEFAULT_STATE };
        }
    }
    save() {
        try {
            writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf-8");
        }
        catch (e) {
            Logger.warn(`[TaskSource] Failed to persist state: ${e}`);
        }
    }
    /** Set the currently active task. */
    claim(task) {
        this.state.active = { ...task, claimedAt: Date.now() };
        this.state.updatedAt = Date.now();
        this.save();
    }
    /** Mark active task complete. */
    complete() {
        if (this.state.active) {
            this.state.lastCompleted = this.state.active;
            this.state.active = null;
        }
        this.state.updatedAt = Date.now();
        this.save();
    }
    /** Add a task to the queue. */
    enqueue(task) {
        this.state.queue.push(task);
        this.state.updatedAt = Date.now();
        this.save();
    }
    /** Add a blocker description. */
    addBlocker(description) {
        if (!this.state.blockers.includes(description)) {
            this.state.blockers.push(description);
            this.state.updatedAt = Date.now();
            this.save();
        }
    }
    /** Clear all blockers. */
    clearBlockers() {
        this.state.blockers = [];
        this.state.updatedAt = Date.now();
        this.save();
    }
    /** Replace the entire state (e.g. from external tool). */
    setState(state) {
        this.state = { ...this.state, ...state, updatedAt: Date.now() };
        this.save();
    }
    getState() {
        return { ...this.state };
    }
    async poll() {
        // Re-read from disk in case another process updated it
        this.state = this.load();
        return this.render();
    }
    destroy() {
        // No resources to clean up
    }
    render() {
        const lines = [];
        const active = this.state.active;
        if (active) {
            const age = active.claimedAt
                ? ` (${this.formatAge(Date.now() - active.claimedAt)})`
                : "";
            lines.push(` active ${active.description}${age}`);
        }
        else {
            lines.push(` active (none)`);
        }
        if (this.state.queue.length > 0) {
            const next = this.state.queue[0];
            lines.push(`   next ${next.description}`);
            if (this.state.queue.length > 1) {
                lines.push(`  queue +${this.state.queue.length - 1} more`);
            }
        }
        else {
            lines.push(`   next (empty)`);
        }
        if (this.state.blockers.length > 0) {
            for (const b of this.state.blockers) {
                lines.push(`blocker ${b}`);
            }
        }
        else {
            lines.push(`blocker none`);
        }
        if (this.state.lastCompleted) {
            lines.push(`   done ${this.state.lastCompleted.description}`);
        }
        return lines.join("\n");
    }
    formatAge(ms) {
        const s = Math.floor(ms / 1000);
        if (s < 60)
            return `${s}s`;
        const m = Math.floor(s / 60);
        return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 > 0 ? (m % 60) + "m" : ""}`;
    }
}

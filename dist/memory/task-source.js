/**
 * TaskSource — sensory channel that renders current task state.
 *
 * Shows active claim, queue depth, blockers, and last completed task.
 * Helps agents stay oriented across restarts without reconstructing
 * intent from memory summaries.
 *
 * Target: under 150 tokens per render.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
export class TaskSource {
    constructor(statePath) {
        this.tasks = [];
        const dir = join(homedir(), ".gro");
        mkdirSync(dir, { recursive: true });
        this.statePath = statePath ?? join(dir, "tasks.json");
        this.load();
    }
    load() {
        try {
            const raw = readFileSync(this.statePath, "utf8");
            this.tasks = JSON.parse(raw);
        }
        catch {
            this.tasks = [];
        }
    }
    save() {
        writeFileSync(this.statePath, JSON.stringify(this.tasks, null, 2));
    }
    claim(summary) {
        const id = Date.now().toString(36);
        // Mark any previous active tasks as queued
        for (const t of this.tasks) {
            if (t.status === "active")
                t.status = "queued";
        }
        this.tasks.unshift({ id, summary, status: "active" });
        this.save();
        return id;
    }
    complete(id) {
        const task = id
            ? this.tasks.find(t => t.id === id)
            : this.tasks.find(t => t.status === "active");
        if (task) {
            task.status = "done";
            task.completedAt = Date.now();
        }
        // Keep only last 3 done tasks + all non-done
        const done = this.tasks.filter(t => t.status === "done").slice(0, 3);
        const active = this.tasks.filter(t => t.status !== "done");
        this.tasks = [...active, ...done];
        this.save();
    }
    setBlocker(blocker, id) {
        const task = id
            ? this.tasks.find(t => t.id === id)
            : this.tasks.find(t => t.status === "active");
        if (task) {
            task.status = "blocked";
            task.blocker = blocker;
            this.save();
        }
    }
    async poll() {
        this.load(); // Re-read in case another process updated
        return this.render();
    }
    destroy() { }
    render() {
        const active = this.tasks.filter(t => t.status === "active");
        const queued = this.tasks.filter(t => t.status === "queued");
        const blocked = this.tasks.filter(t => t.status === "blocked");
        const lastDone = this.tasks.filter(t => t.status === "done")[0];
        const lines = [];
        if (active.length > 0) {
            lines.push(` active ${active[0].summary}`);
        }
        else {
            lines.push(` active (none)`);
        }
        if (queued.length > 0) {
            lines.push(`  queue ${queued.length} pending`);
            for (const t of queued.slice(0, 2)) {
                lines.push(`       - ${t.summary}`);
            }
        }
        if (blocked.length > 0) {
            for (const t of blocked) {
                lines.push(`blocked ${t.summary} [${t.blocker ?? "unknown"}]`);
            }
        }
        if (lastDone) {
            lines.push(`   last ${lastDone.summary}`);
        }
        return lines.length > 0 ? lines.join("\n") : "(no tasks)";
    }
}

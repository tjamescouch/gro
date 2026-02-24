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
import type { SensorySource } from "./sensory-memory.js";
import { Logger } from "../logger.js";

export interface Task {
  id: string;
  description: string;
  claimedAt?: number;
}

export interface TaskState {
  active: Task | null;
  queue: Task[];
  blockers: string[];
  lastCompleted: Task | null;
  updatedAt: number;
}

const DEFAULT_STATE: TaskState = {
  active: null,
  queue: [],
  blockers: [],
  lastCompleted: null,
  updatedAt: Date.now(),
};

export class TaskSource implements SensorySource {
  private statePath: string;
  private state: TaskState;

  constructor(statePath?: string) {
    const groDir = join(homedir(), ".gro");
    mkdirSync(groDir, { recursive: true });
    this.statePath = statePath ?? join(groDir, "tasks.json");
    this.state = this.load();
  }

  private load(): TaskState {
    try {
      const raw = readFileSync(this.statePath, "utf-8");
      return { ...DEFAULT_STATE, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  private save(): void {
    try {
      writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf-8");
    } catch (e) {
      Logger.warn(`[TaskSource] Failed to persist state: ${e}`);
    }
  }

  /** Set the currently active task. */
  claim(task: Task): void {
    this.state.active = { ...task, claimedAt: Date.now() };
    this.state.updatedAt = Date.now();
    this.save();
  }

  /** Mark active task complete. */
  complete(): void {
    if (this.state.active) {
      this.state.lastCompleted = this.state.active;
      this.state.active = null;
    }
    this.state.updatedAt = Date.now();
    this.save();
  }

  /** Add a task to the queue. */
  enqueue(task: Task): void {
    this.state.queue.push(task);
    this.state.updatedAt = Date.now();
    this.save();
  }

  /** Add a blocker description. */
  addBlocker(description: string): void {
    if (!this.state.blockers.includes(description)) {
      this.state.blockers.push(description);
      this.state.updatedAt = Date.now();
      this.save();
    }
  }

  /** Clear all blockers. */
  clearBlockers(): void {
    this.state.blockers = [];
    this.state.updatedAt = Date.now();
    this.save();
  }

  /** Replace the entire state (e.g. from external tool). */
  setState(state: Partial<TaskState>): void {
    this.state = { ...this.state, ...state, updatedAt: Date.now() };
    this.save();
  }

  getState(): TaskState {
    return { ...this.state };
  }

  async poll(): Promise<string | null> {
    // Re-read from disk in case another process updated it
    this.state = this.load();
    return this.render();
  }

  destroy(): void {
    // No resources to clean up
  }

  render(): string {
    const lines: string[] = [];

    const active = this.state.active;
    if (active) {
      const age = active.claimedAt
        ? ` (${this.formatAge(Date.now() - active.claimedAt)})`
        : "";
      lines.push(` active ${active.description}${age}`);
    } else {
      lines.push(` active (none)`);
    }

    if (this.state.queue.length > 0) {
      const next = this.state.queue[0];
      lines.push(`   next ${next.description}`);
      if (this.state.queue.length > 1) {
        lines.push(`  queue +${this.state.queue.length - 1} more`);
      }
    } else {
      lines.push(`   next (empty)`);
    }

    if (this.state.blockers.length > 0) {
      for (const b of this.state.blockers) {
        lines.push(`blocker ${b}`);
      }
    } else {
      lines.push(`blocker none`);
    }

    if (this.state.lastCompleted) {
      lines.push(`   done ${this.state.lastCompleted.description}`);
    }

    return lines.join("\n");
  }

  private formatAge(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 > 0 ? (m % 60) + "m" : ""}`;
  }
}

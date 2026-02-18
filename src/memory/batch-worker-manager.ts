/**
 * BatchWorkerManager — lifecycle management for BatchWorker subprocess.
 * 
 * Spawns BatchWorker as a child process, manages its lifecycle (start/stop),
 * and handles graceful shutdown when the parent gro process exits.
 */

import { fork, ChildProcess } from "node:child_process";
import { Logger } from "../logger.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface BatchWorkerManagerConfig {
  queuePath: string;
  pagesDir: string;
  apiKey: string;
  pollInterval?: number;
  batchPollInterval?: number;
  batchSize?: number;
  model?: string;
}

export class BatchWorkerManager {
  private worker: ChildProcess | null = null;
  private cfg: BatchWorkerManagerConfig;
  private stopping = false;

  constructor(config: BatchWorkerManagerConfig) {
    this.cfg = config;
    // Register cleanup once at construction time
    process.once("exit", () => this.stop());
  }

  /**
   * Spawn the batch worker process.
   */
  start(): void {
    if (this.worker) {
      Logger.warn("[BatchWorkerManager] Worker already running");
      return;
    }

    Logger.info("[BatchWorkerManager] Starting batch worker subprocess");

    // Path to the standalone worker script (in dist/)
    const workerScript = join(__dirname, "../batch-worker-standalone.js");

    // Build args from config (no secrets in argv — visible in ps aux)
    const args: string[] = [
      "--queue-path", this.cfg.queuePath,
      "--pages-dir", this.cfg.pagesDir,
    ];

    if (this.cfg.pollInterval !== undefined) {
      args.push("--poll-interval", this.cfg.pollInterval.toString());
    }
    if (this.cfg.batchPollInterval !== undefined) {
      args.push("--batch-poll-interval", this.cfg.batchPollInterval.toString());
    }
    if (this.cfg.batchSize !== undefined) {
      args.push("--batch-size", this.cfg.batchSize.toString());
    }
    if (this.cfg.model !== undefined) {
      args.push("--model", this.cfg.model);
    }

    // Fork the worker — pass API key via env, not argv
    this.worker = fork(workerScript, args, {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      detached: false,
      env: { ...process.env, GRO_BATCH_API_KEY: this.cfg.apiKey },
    });

    Logger.info(`[BatchWorkerManager] Worker spawned (PID ${this.worker.pid})`);

    // Handle worker exit
    this.worker.on("exit", (code, signal) => {
      if (!this.stopping) {
        Logger.error(`[BatchWorkerManager] Worker exited unexpectedly (code ${code}, signal ${signal})`);
      } else {
        Logger.info("[BatchWorkerManager] Worker exited cleanly");
      }
      this.worker = null;
    });

    // Handle worker errors
    this.worker.on("error", (err) => {
      Logger.error(`[BatchWorkerManager] Worker error: ${err}`);
    });

  }

  /**
   * Stop the batch worker process.
   */
  stop(): void {
    if (!this.worker) {
      return;
    }

    this.stopping = true;
    Logger.info("[BatchWorkerManager] Stopping batch worker");

    try {
      this.worker.kill("SIGTERM");
      this.worker = null;
    } catch (err) {
      Logger.error(`[BatchWorkerManager] Failed to stop worker: ${err}`);
    }
  }

  /**
   * Check if worker is running.
   */
  isRunning(): boolean {
    return this.worker !== null && !this.worker.killed;
  }
}

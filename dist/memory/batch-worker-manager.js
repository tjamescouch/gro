/**
 * BatchWorkerManager — lifecycle management for BatchWorker subprocess.
 *
 * Spawns BatchWorker as a child process, manages its lifecycle (start/stop),
 * and handles graceful shutdown when the parent gro process exits.
 */
import { fork } from "node:child_process";
import { Logger } from "../logger.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export class BatchWorkerManager {
    constructor(config) {
        this.worker = null;
        this.stopping = false;
        this.cfg = config;
    }
    /**
     * Spawn the batch worker process.
     */
    start() {
        if (this.worker) {
            Logger.warn("[BatchWorkerManager] Worker already running");
            return;
        }
        Logger.info("[BatchWorkerManager] Starting batch worker subprocess");
        // Path to the standalone worker script (in dist/)
        const workerScript = join(__dirname, "../batch-worker-standalone.js");
        // Build args from config
        const args = [
            "--queue-path", this.cfg.queuePath,
            "--pages-dir", this.cfg.pagesDir,
            "--api-key", this.cfg.apiKey,
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
        // Fork the worker
        this.worker = fork(workerScript, args, {
            stdio: ["ignore", "inherit", "inherit", "ipc"],
            detached: false,
        });
        Logger.info(`[BatchWorkerManager] Worker spawned (PID ${this.worker.pid})`);
        // Handle worker exit
        this.worker.on("exit", (code, signal) => {
            if (!this.stopping) {
                Logger.error(`[BatchWorkerManager] Worker exited unexpectedly (code ${code}, signal ${signal})`);
            }
            else {
                Logger.info("[BatchWorkerManager] Worker exited cleanly");
            }
            this.worker = null;
        });
        // Handle worker errors
        this.worker.on("error", (err) => {
            Logger.error(`[BatchWorkerManager] Worker error: ${err}`);
        });
        // Register cleanup on parent exit
        process.on("exit", () => {
            this.stop();
        });
    }
    /**
     * Stop the batch worker process.
     */
    stop() {
        if (!this.worker) {
            return;
        }
        this.stopping = true;
        Logger.info("[BatchWorkerManager] Stopping batch worker");
        try {
            this.worker.kill("SIGTERM");
            this.worker = null;
        }
        catch (err) {
            Logger.error(`[BatchWorkerManager] Failed to stop worker: ${err}`);
        }
    }
    /**
     * Check if worker is running.
     */
    isRunning() {
        return this.worker !== null && !this.worker.killed;
    }
}

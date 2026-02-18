#!/usr/bin/env node
/**
 * Standalone batch worker runner.
 * 
 * This runs the BatchWorker as an independent process, separate from gro main loop.
 * 
 * Usage:
 *   node dist/batch-worker-standalone.js --queue-path <path> --pages-dir <path> --api-key <key>
 * 
 * Or set via environment:
 *   ANTHROPIC_API_KEY=... QUEUE_PATH=... PAGES_DIR=... node dist/batch-worker-standalone.js
 */

import { BatchWorker } from "./memory/batch-worker.js";
import { Logger } from "./logger.js";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);

function getArg(flag: string, envVar?: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  if (envVar && process.env[envVar]) {
    return process.env[envVar];
  }
  return undefined;
}

function getNumArg(flag: string, envVar?: string, defaultValue?: number): number | undefined {
  const val = getArg(flag, envVar);
  if (val) {
    const num = parseInt(val, 10);
    if (!isNaN(num)) return num;
  }
  return defaultValue;
}

const queuePath = getArg("--queue-path", "QUEUE_PATH") || "/tmp/gro-queue.json";
const pagesDir = getArg("--pages-dir", "PAGES_DIR") || "/tmp/gro-pages";
// API key: prefer GRO_BATCH_API_KEY (set by BatchWorkerManager) then ANTHROPIC_API_KEY
const apiKey = process.env.GRO_BATCH_API_KEY || getArg("--api-key", "ANTHROPIC_API_KEY");
const pollInterval = getNumArg("--poll-interval", "POLL_INTERVAL", 60000);
const batchPollInterval = getNumArg("--batch-poll-interval", "BATCH_POLL_INTERVAL", 300000);
const batchSize = getNumArg("--batch-size", "BATCH_SIZE", 10000);
const model = getArg("--model", "BATCH_MODEL") || "claude-haiku-4-5";

if (!apiKey) {
  Logger.error("[Standalone] ANTHROPIC_API_KEY not set (use --api-key or env var)");
  process.exit(1);
}

Logger.info("[Standalone] Starting BatchWorker");
Logger.info(`[Standalone]   queue: ${queuePath}`);
Logger.info(`[Standalone]   pages: ${pagesDir}`);
Logger.info(`[Standalone]   poll: ${pollInterval}ms / batch poll: ${batchPollInterval}ms`);
Logger.info(`[Standalone]   model: ${model}, batchSize: ${batchSize}`);

const worker = new BatchWorker({
  queuePath,
  pagesDir,
  apiKey,
  pollInterval,
  batchPollInterval,
  batchSize,
  model,
});

worker.start();

// Handle graceful shutdown
process.on("SIGINT", () => {
  Logger.info("[Standalone] Received SIGINT, shutting down");
  worker.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  Logger.info("[Standalone] Received SIGTERM, shutting down");
  worker.stop();
  process.exit(0);
});

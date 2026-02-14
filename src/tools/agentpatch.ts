/**
 * agentpatch tool integration for gro.
 *
 * Exposes a first-class file editor: `apply_patch`.
 *
 * This wraps the agentpatch patch grammar and applies patches via the
 * `agentpatch/bin/apply_patch` script.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "../logger.js";

const DEFAULT_TIMEOUT = 120_000;
const MAX_OUTPUT = 30_000;

export function agentpatchToolDefinition(): any {
  return {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Apply a unified agentpatch-style patch to the working tree (safe, idempotent).",
      parameters: {
        type: "object",
        properties: {
          patch: { type: "string", description: "The patch text (agentpatch grammar)." },
          dry_run: { type: "boolean", description: "If true, validate/preview without writing." },
          verbose: { type: "boolean", description: "If true, emit debug logs from applier." },
          allow_delete: { type: "boolean", description: "Allow *** Delete File ops." },
          allow_rename: { type: "boolean", description: "Allow *** Rename File ops." },
          timeout: { type: "number", description: "Timeout in ms (default 120000)." },
        },
        required: ["patch"],
      },
    },
  };
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  const half = Math.floor(MAX_OUTPUT / 2);
  return s.slice(0, half) + `\n\n... (truncated ${s.length - MAX_OUTPUT} chars) ...\n\n` + s.slice(-half);
}

export function executeAgentpatch(args: Record<string, any>): string {
  const patch = (args.patch as string) || "";
  if (!patch.trim()) return "Error: empty patch";

  const timeout = (args.timeout as number) || DEFAULT_TIMEOUT;
  const dryRun = args.dry_run === true;
  const verbose = args.verbose === true;
  const allowDelete = args.allow_delete === true;
  const allowRename = args.allow_rename === true;

  // Expected layout in this monorepo-ish runner: /home/agent/agentpatch
  // If not present, instruct user to clone it.
  const agentpatchPath = process.env.AGENTPATCH_PATH || join(process.env.HOME || "", "agentpatch");
  const bin = join(agentpatchPath, "bin", "apply_patch");
  if (!existsSync(bin)) {
    return `Error: agentpatch not found at ${bin}. Set AGENTPATCH_PATH or clone agentpatch to ~/agentpatch.`;
  }

  const cmd = [bin];
  if (dryRun) cmd.push("--dry-run");
  if (verbose) cmd.push("--verbose");
  if (allowDelete) cmd.push("--allow-delete");
  if (allowRename) cmd.push("--allow-rename");

  Logger.debug(`apply_patch: ${cmd.join(" ")}`);

  try {
    const out = execSync(cmd.join(" "), {
      shell: "/bin/bash",
      input: patch,
      encoding: "utf-8",
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return truncate(out || "ok");
  } catch (e: any) {
    let result = "";
    if (e.stdout) result += e.stdout;
    if (e.stderr) result += (result ? "\n" : "") + e.stderr;
    if (!result) result = e.message || "Command failed";
    if (e.status != null) result += `\n[exit code: ${e.status}]`;
    return truncate(result);
  }
}

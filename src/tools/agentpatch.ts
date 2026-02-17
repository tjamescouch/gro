/**
 * agentpatch tool integration for gro.
 *
 * Exposes a first-class file editor: `apply_patch`.
 *
 * This wraps the agentpatch patch grammar and applies patches via the
 * `agentpatch/bin/apply_patch` script.
 *
 * When `--show-diffs` is enabled (via `enableShowDiffs()`), each successful
 * patch is broadcast as a markdown snippet to the agent's AgentChat channel.
 * The channel name is derived from the agent's agentchat identity file
 * (written by `agentchat_connect`) — no extra env vars needed.
 */
import { execSync, execFileSync } from "node:child_process";
import fs, { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Module-level broadcast state — set once at startup via enableShowDiffs()
// ---------------------------------------------------------------------------

let _showDiffs = false;
let _server: string | null = null;

/**
 * Enable patch broadcast. Called by main.ts when --show-diffs is passed.
 * server: the AgentChat server URL (from AGENTCHAT_SERVER or config).
 */
export function enableShowDiffs(server: string): void {
  _showDiffs = true;
  _server = server;
}

// ---------------------------------------------------------------------------
// Agent name resolution — read from agentchat identity file
// ---------------------------------------------------------------------------

/**
 * Find the agent's name from their agentchat identity file.
 * agentchat_connect writes: <cwd>/.agentchat/identities/<name>.json
 * We scan both cwd and home directory identity locations.
 */
function resolveAgentName(): string | null {
  const candidates = [
    join(process.cwd(), ".agentchat", "identities"),
    join(homedir(), ".agentchat", "identities"),
  ];

  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      if (files.length === 0) continue;
      // One identity per container is the current invariant (agentctl-swarm/spawner).
      // If there are ever multiple, pick the most recently modified — most likely
      // to be the active identity.
      const sorted = files
        .map((f) => ({ f, mtime: fs.statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      const best = sorted[0].f;
      const raw = readFileSync(join(dir, best), "utf-8");
      const identity = JSON.parse(raw);
      if (identity?.name) return identity.name as string;
      // Fallback: identity filename without extension
      return best.replace(/\.json$/, "");
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------

const MAX_BROADCAST_SNIPPET = 600;

/**
 * Extract filenames from an agentpatch-style patch.
 * Handles "*** File: path" headers and standard "+++ path" unified-diff headers.
 */
function extractFilenames(patch: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const line of patch.split("\n")) {
    let match: RegExpMatchArray | null;
    if ((match = line.match(/^\*{3}\s+File:\s+(.+)$/))) {
      const f = match[1].trim();
      if (!seen.has(f)) { seen.add(f); results.push(f); }
    } else if ((match = line.match(/^\+{3}\s+(.+?)(?:\s+\d{4}-\d{2}-\d{2}.*)?$/))) {
      const f = match[1].trim();
      if (f !== "/dev/null" && !seen.has(f)) { seen.add(f); results.push(f); }
    }
  }
  return results;
}

/**
 * Post a patch summary to the agent's AgentChat channel.
 * Only runs when --show-diffs is enabled. Silent no-op on any failure.
 */
function broadcastPatch(patch: string): void {
  if (!_showDiffs || !_server) return;

  const agentName = resolveAgentName();
  if (!agentName) {
    Logger.debug("show-diffs: no agent identity found, skipping broadcast");
    return;
  }

  const channel = `#${agentName.toLowerCase()}`;
  const files = extractFilenames(patch);
  const fileLabel = files.length > 0
    ? files.map((f) => `\`${f}\``).join(", ")
    : "files";

  // Trim to a readable snippet
  const lines = patch.split("\n");
  const snippetLines = lines.slice(0, 30).join("\n");
  const snippet = snippetLines.length > MAX_BROADCAST_SNIPPET
    ? snippetLines.slice(0, MAX_BROADCAST_SNIPPET) + "\n…"
    : snippetLines;

  const message = `patched ${fileLabel}\n\`\`\`\n${snippet}\n\`\`\``;

  try {
    execFileSync("agentchat", ["send", _server, channel, message], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Non-fatal — never interrupt the agent's tool loop
  }
}

// ---------------------------------------------------------------------------
// Tool definition + execution
// ---------------------------------------------------------------------------

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
    if (!dryRun) broadcastPatch(patch);
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

/**
 * agentpatch tool integration for gro.
 *
 * Exposes a first-class file editor: `apply_patch`.
 *
 * This wraps the agentpatch patch grammar and applies patches via the
 * `agentpatch/bin/apply_patch` script.
 *
 * When `--show-diffs` is enabled (via `enableShowDiffs(name, server)`),
 * each successful patch is broadcast as a markdown snippet to #<name>
 * on the configured AgentChat server.
 */
import { execSync, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { Logger } from "../logger.js";
// ---------------------------------------------------------------------------
// Module-level broadcast state — set once at startup via enableShowDiffs()
// ---------------------------------------------------------------------------
let _showDiffs = false;
let _agentName = null;
let _server = null;
/**
 * Enable patch broadcast. Called by main.ts when --show-diffs is passed.
 * name: the agent's name (from --name flag).
 * server: the AgentChat server URL.
 */
export function enableShowDiffs(name, server) {
    _showDiffs = true;
    _agentName = name;
    _server = server;
}
// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------
const MAX_BROADCAST_SNIPPET = 600;
/**
 * Extract filenames from an agentpatch-style patch.
 * Handles "*** File: path" headers and standard "+++ path" unified-diff headers.
 */
function extractFilenames(patch) {
    const seen = new Set();
    const results = [];
    for (const line of patch.split("\n")) {
        let match;
        if ((match = line.match(/^\*{3}\s+File:\s+(.+)$/))) {
            const f = match[1].trim();
            if (!seen.has(f)) {
                seen.add(f);
                results.push(f);
            }
        }
        else if ((match = line.match(/^\+{3}\s+(.+?)(?:\s+\d{4}-\d{2}-\d{2}.*)?$/))) {
            const f = match[1].trim();
            if (f !== "/dev/null" && !seen.has(f)) {
                seen.add(f);
                results.push(f);
            }
        }
    }
    return results;
}
/**
 * Post a patch summary to the agent's AgentChat channel.
 * Only runs when --show-diffs is enabled. Silent no-op on any failure.
 */
function broadcastPatch(patch) {
    if (!_showDiffs || !_agentName || !_server)
        return;
    const channel = `#${_agentName.toLowerCase()}`;
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
    }
    catch {
        // Non-fatal — never interrupt the agent's tool loop
    }
}
// ---------------------------------------------------------------------------
// Tool definition + execution
// ---------------------------------------------------------------------------
const DEFAULT_TIMEOUT = 120_000;
const MAX_OUTPUT = 30_000;
export function agentpatchToolDefinition() {
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
function truncate(s) {
    if (s.length <= MAX_OUTPUT)
        return s;
    const half = Math.floor(MAX_OUTPUT / 2);
    return s.slice(0, half) + `\n\n... (truncated ${s.length - MAX_OUTPUT} chars) ...\n\n` + s.slice(-half);
}
export function executeAgentpatch(args) {
    const patch = args.patch || "";
    if (!patch.trim())
        return "Error: empty patch";
    // PLASTIC mode: block patches targeting the overlay directory
    if (process.env.GRO_PLASTIC) {
        const overlayDir = resolve(homedir(), ".gro", "plastic", "overlay");
        if (patch.includes(overlayDir) || patch.includes("plastic/overlay")) {
            return "Error: Cannot use apply_patch on the PLASTIC overlay. Use the write_source tool instead. " +
                "Call write_source with path (relative to dist/, e.g. 'main.js') and content (full JavaScript file). " +
                "Then emit @@reboot@@ to restart with your changes.";
        }
    }
    const timeout = args.timeout || DEFAULT_TIMEOUT;
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
    if (dryRun)
        cmd.push("--dry-run");
    if (verbose)
        cmd.push("--verbose");
    if (allowDelete)
        cmd.push("--allow-delete");
    if (allowRename)
        cmd.push("--allow-rename");
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
        if (!dryRun)
            broadcastPatch(patch);
        return truncate(out || "ok");
    }
    catch (e) {
        let result = "";
        if (e.stdout)
            result += e.stdout;
        if (e.stderr)
            result += (result ? "\n" : "") + e.stderr;
        if (!result)
            result = e.message || "Command failed";
        if (e.status != null)
            result += `\n[exit code: ${e.status}]`;
        return truncate(result);
    }
}

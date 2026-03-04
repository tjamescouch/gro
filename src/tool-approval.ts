/**
 * Tool approval system — prompts the user before executing dangerous tools.
 * In interactive mode (TTY), shows a y/n/a keypress prompt on stderr.
 * In non-interactive mode or with --yes, tools auto-approve.
 */

import { C } from "./logger.js";

/** Tools that require user approval before execution. */
export const DANGEROUS_TOOLS = new Set([
  "Write",
  "apply_patch",
  "shell",
]);

export type ApprovalResult = "yes" | "no" | "always";

/** Format a human-readable summary of what a tool call will do. */
export function formatToolSummary(fnName: string, fnArgs: Record<string, unknown>): string {
  switch (fnName) {
    case "Write": {
      const fp = String(fnArgs.file_path ?? "unknown");
      const size = typeof fnArgs.content === "string" ? fnArgs.content.length : 0;
      const sizeStr = size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;
      return `Write ${sizeStr} → ${fp}`;
    }
    case "apply_patch": {
      const patch = String(fnArgs.patch ?? fnArgs.diff ?? "");
      const files = patch.match(/\*\*\* (?:File|Update|Add|Delete): (.+)/g)
        ?.map(m => m.replace(/\*\*\* (?:File|Update|Add|Delete): /, "")) ?? [];
      return files.length > 0
        ? `Patch ${files.length} file(s): ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` +${files.length - 3} more` : ""}`
        : `Apply patch (${patch.length} chars)`;
    }
    case "shell": {
      const cmd = String(fnArgs.command ?? "unknown");
      return cmd.length > 80 ? `Run: ${cmd.slice(0, 77)}...` : `Run: ${cmd}`;
    }
    default:
      return `${fnName}(...)`;
  }
}

export interface ApprovalGateOptions {
  /** Persistent set of tool names the user has "always"-approved this session. */
  sessionAllowlist: Set<string>;
  /** Output format for stream-json event emission. */
  outputFormat: "text" | "json" | "stream-json";
}

/**
 * Create an approval gate function for interactive mode.
 * Returns a function that prompts via single keypress before dangerous tools.
 */
export function createApprovalGate(
  opts: ApprovalGateOptions,
): (fnName: string, fnArgs: Record<string, unknown>) => Promise<ApprovalResult> {
  return async (fnName, fnArgs) => {
    // Non-dangerous tools pass through
    if (!DANGEROUS_TOOLS.has(fnName)) return "yes";
    // Session allowlist (user pressed "a" previously for this tool)
    if (opts.sessionAllowlist.has(fnName)) return "yes";

    const summary = formatToolSummary(fnName, fnArgs);

    // Emit stream-json event for TUI integration
    if (opts.outputFormat === "stream-json") {
      process.stdout.write(JSON.stringify({ type: "tool_approval_request", name: fnName, summary }) + "\n");
    }

    // Prompt on stderr
    process.stderr.write(C.yellow(`  ? ${summary}`) + C.gray("  [y]es / [n]o / [a]lways "));

    const result = await readApprovalKeypress();

    // Echo the choice
    const label = result === "always" ? "always" : result === "yes" ? "yes" : "no";
    process.stderr.write(C.gray(label) + "\n");

    // Emit stream-json response
    if (opts.outputFormat === "stream-json") {
      process.stdout.write(JSON.stringify({
        type: "tool_approval_response",
        name: fnName,
        approved: result !== "no",
        always: result === "always",
      }) + "\n");
    }

    // Update session allowlist
    if (result === "always") {
      opts.sessionAllowlist.add(fnName);
    }

    return result;
  };
}

/** Read a single y/n/a keypress from stdin. */
function readApprovalKeypress(): Promise<ApprovalResult> {
  return new Promise((resolve) => {
    const handler = (_ch: string, key: { name?: string; sequence?: string }) => {
      if (!key) return;
      const k = key.name;
      if (k === "y" || k === "return") {
        process.stdin.removeListener("keypress", handler);
        resolve("yes");
      } else if (k === "n" || k === "escape") {
        process.stdin.removeListener("keypress", handler);
        resolve("no");
      } else if (k === "a") {
        process.stdin.removeListener("keypress", handler);
        resolve("always");
      }
      // Other keys ignored — keep waiting
    };
    process.stdin.on("keypress", handler);
  });
}

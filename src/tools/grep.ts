/**
 * Built-in Grep tool for gro — searches file contents with regex.
 * Matches Claude Code's Grep tool interface.
 */
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { Logger } from "../logger.js";

const MAX_RESULTS = 200;
const DEFAULT_TIMEOUT = 30_000;

export function grepToolDefinition(): any {
  return {
    type: "function",
    function: {
      name: "Grep",
      description:
        "Search file contents using a regex pattern. Returns matching lines with file paths and line numbers. " +
        "Searches recursively from the given path. Use this instead of `grep -r`.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regex pattern to search for (POSIX extended regex)",
          },
          path: {
            type: "string",
            description: "Directory or file to search in (default: cwd)",
          },
          include: {
            type: "string",
            description: 'File pattern to include (e.g., "*.ts", "*.md")',
          },
        },
        required: ["pattern"],
      },
    },
  };
}

export function executeGrep(args: Record<string, unknown>): string {
  const pattern = args.pattern as string;
  if (!pattern) return "Error: pattern is required";

  const searchPath = resolve((args.path as string) || ".");
  const include = args.include as string;

  Logger.debug(`Grep: /${pattern}/ in ${searchPath}`);

  try {
    let cmd = "grep -rn --color=never -E";

    if (include) {
      cmd += ` --include=${JSON.stringify(include)}`;
    }

    // Exclude common noise directories
    cmd += " --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build";
    cmd += ` ${JSON.stringify(pattern)} ${JSON.stringify(searchPath)}`;
    cmd += ` | head -${MAX_RESULTS + 1}`;

    const output = execSync(cmd, {
      encoding: "utf-8",
      timeout: DEFAULT_TIMEOUT,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!output) {
      return `No matches found for: ${pattern}`;
    }

    const lines = output.split("\n").filter(Boolean);
    const truncated = lines.length > MAX_RESULTS;
    const result = lines.slice(0, MAX_RESULTS);

    let header = `Found ${Math.min(lines.length, MAX_RESULTS)} match(es)`;
    if (truncated) header += ` (truncated to ${MAX_RESULTS}, more exist)`;
    header += `:`;

    return header + "\n" + result.join("\n");
  } catch (e: unknown) {
    // grep exits 1 on no matches — that's not an error
    if (e.status === 1) {
      return `No matches found for: ${pattern}`;
    }
    return `Error: ${String(e)}`;
  }
}

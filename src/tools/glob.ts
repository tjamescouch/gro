/**
 * Built-in Glob tool for gro — finds files by pattern.
 * Matches Claude Code's Glob tool interface.
 */
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { Logger } from "../logger.js";

const MAX_RESULTS = 500;
const DEFAULT_TIMEOUT = 15_000;

export function globToolDefinition(): any {
  return {
    type: "function",
    function: {
      name: "Glob",
      description:
        "Find files matching a glob pattern. Returns matching file paths, one per line. " +
        "Respects .gitignore by default. Use this instead of `find` or `ls -R`.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: 'Glob pattern to match (e.g., "**/*.ts", "src/**/*.test.ts", "*.md")',
          },
          path: {
            type: "string",
            description: "Directory to search in (default: cwd)",
          },
        },
        required: ["pattern"],
      },
    },
  };
}

export function executeGlob(args: Record<string, any>): string {
  const pattern = args.pattern as string;
  if (!pattern) return "Error: pattern is required";

  const searchPath = resolve((args.path as string) || ".");

  Logger.debug(`Glob: ${pattern} in ${searchPath}`);

  try {
    // Use git ls-files for .gitignore awareness, fall back to find
    let output: string;
    try {
      // Try git-aware glob first
      output = execSync(
        `cd ${JSON.stringify(searchPath)} && git ls-files --cached --others --exclude-standard 2>/dev/null | grep -E '${globToRegex(pattern)}' | head -${MAX_RESULTS + 1}`,
        { encoding: "utf-8", timeout: DEFAULT_TIMEOUT, stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
    } catch {
      // Fall back to find with basic glob
      output = execSync(
        `find ${JSON.stringify(searchPath)} -type f -name ${JSON.stringify(extractBaseName(pattern))} 2>/dev/null | head -${MAX_RESULTS + 1}`,
        { encoding: "utf-8", timeout: DEFAULT_TIMEOUT, stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
    }

    if (!output) {
      return `No files matched pattern: ${pattern}`;
    }

    const files = output.split("\n").filter(Boolean);
    const truncated = files.length > MAX_RESULTS;
    const result = files.slice(0, MAX_RESULTS);

    let header = `Found ${Math.min(files.length, MAX_RESULTS)} file(s)`;
    if (truncated) header += ` (truncated to ${MAX_RESULTS}, more exist)`;
    header += `:`;

    return header + "\n" + result.join("\n");
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

/**
 * Convert a simple glob pattern to a regex for grep.
 * Handles **, *, and ? wildcards.
 */
function globToRegex(pattern: string): string {
  return pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex specials
    .replace(/\*\*/g, "___DOUBLESTAR___")
    .replace(/\*/g, "[^/]*")
    .replace(/___DOUBLESTAR___/g, ".*")
    .replace(/\?/g, ".");
}

/**
 * Extract the base filename pattern from a glob for use with find -name.
 */
function extractBaseName(pattern: string): string {
  const parts = pattern.split("/");
  return parts[parts.length - 1] || "*";
}

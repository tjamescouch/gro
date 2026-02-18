/**
 * Built-in bash tool for gro — executes shell commands and returns output.
 * Gated behind --bash flag. Not enabled by default.
 */
import { execSync } from "node:child_process";
import { Logger } from "../logger.js";
const MAX_OUTPUT = 30_000;
const DEFAULT_TIMEOUT = 120_000;
export function bashToolDefinition() {
    return {
        type: "function",
        function: {
            name: "shell",
            description: "Execute a shell command and return its output (stdout + stderr).",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "The bash command to execute" },
                    timeout: { type: "number", description: "Timeout in milliseconds (default: 120000)" },
                },
                required: ["command"],
            },
        },
    };
}
export function executeBash(args) {
    const command = args.command;
    if (!command)
        return "Error: no command provided";
    const timeout = args.timeout || DEFAULT_TIMEOUT;
    Logger.debug(`bash: ${command}`);
    try {
        const output = execSync(command, {
            shell: "/bin/bash",
            encoding: "utf-8",
            timeout,
            maxBuffer: 10 * 1024 * 1024,
            stdio: ["pipe", "pipe", "pipe"],
        });
        return truncate(output);
    }
    catch (e) {
        // execSync throws on non-zero exit — capture stdout + stderr
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
function truncate(s) {
    if (s.length <= MAX_OUTPUT)
        return s;
    const half = Math.floor(MAX_OUTPUT / 2);
    return s.slice(0, half) + `\n\n... (truncated ${s.length - MAX_OUTPUT} chars) ...\n\n` + s.slice(-half);
}

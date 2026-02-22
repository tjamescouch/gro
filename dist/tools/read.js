/**
 * Built-in Read tool for gro — reads file contents with optional line range.
 * Matches Claude Code's Read tool interface.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Logger } from "../logger.js";
const MAX_OUTPUT = 256_000; // ~256KB max read
const MAX_LINE_COUNT = 10_000; // max lines to return at once
export function readToolDefinition() {
    return {
        type: "function",
        function: {
            name: "Read",
            description: "Read the contents of a file. Returns the file content as a string. " +
                "Use offset/limit to read specific line ranges for large files.",
            parameters: {
                type: "object",
                properties: {
                    file_path: {
                        type: "string",
                        description: "Path to the file to read (absolute or relative to cwd)",
                    },
                    offset: {
                        type: "number",
                        description: "Line number to start reading from (0-based, default: 0)",
                    },
                    limit: {
                        type: "number",
                        description: "Maximum number of lines to read (default: all lines)",
                    },
                },
                required: ["file_path"],
            },
        },
    };
}
export function executeRead(args) {
    const filePath = args.file_path;
    if (!filePath)
        return "Error: file_path is required";
    const resolved = resolve(filePath);
    if (!existsSync(resolved)) {
        return `Error: file not found: ${resolved}`;
    }
    const stat = statSync(resolved);
    if (stat.isDirectory()) {
        return `Error: ${resolved} is a directory, not a file. Use Glob to list directory contents.`;
    }
    if (stat.size > MAX_OUTPUT * 4) {
        return `Error: file too large (${(stat.size / 1024).toFixed(0)}KB). Use offset/limit to read portions, or bash to process.`;
    }
    Logger.debug(`Read: ${resolved}`);
    try {
        const content = readFileSync(resolved, "utf-8");
        const lines = content.split("\n");
        const offset = Math.max(0, args.offset || 0);
        const limit = args.limit || lines.length;
        const cappedLimit = Math.min(limit, MAX_LINE_COUNT);
        if (offset >= lines.length) {
            return `Error: offset ${offset} exceeds file length (${lines.length} lines)`;
        }
        const slice = lines.slice(offset, offset + cappedLimit);
        const result = slice.join("\n");
        // Include line info header when using offset/limit
        if (offset > 0 || cappedLimit < lines.length) {
            const endLine = Math.min(offset + cappedLimit, lines.length);
            return `[Lines ${offset + 1}-${endLine} of ${lines.length}]\n${result}`;
        }
        return result;
    }
    catch (e) {
        return `Error reading file: ${String(e)}`;
    }
}

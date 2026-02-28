/**
 * Built-in Write tool for gro — creates or overwrites files.
 * For surgical edits, use apply_patch instead.
 */
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { Logger } from "../logger.js";
const MAX_WRITE_SIZE = 1_000_000; // 1MB max write
export function writeToolDefinition() {
    return {
        type: "function",
        function: {
            name: "Write",
            description: "Write content to a file. Creates the file and any parent directories if they don't exist. " +
                "Overwrites existing content. For surgical edits to existing files, use apply_patch instead.",
            parameters: {
                type: "object",
                properties: {
                    file_path: {
                        type: "string",
                        description: "Path to the file to write (absolute or relative to cwd)",
                    },
                    content: {
                        type: "string",
                        description: "Content to write to the file",
                    },
                },
                required: ["file_path", "content"],
            },
        },
    };
}
export function executeWrite(args) {
    const filePath = args.file_path;
    const content = args.content;
    if (!filePath)
        return "Error: file_path is required";
    if (content === undefined || content === null)
        return "Error: content is required";
    if (content.length > MAX_WRITE_SIZE) {
        return `Error: content too large (${(content.length / 1024).toFixed(0)}KB). Max is ${(MAX_WRITE_SIZE / 1024).toFixed(0)}KB.`;
    }
    const resolved = resolve(filePath);
    const dir = dirname(resolved);
    // PLASTIC mode: block writes to the overlay directory — use write_source tool instead
    if (process.env.GRO_PLASTIC) {
        const overlayDir = resolve(homedir(), ".gro", "plastic", "overlay");
        if (resolved.startsWith(overlayDir)) {
            return "Error: Cannot use Write tool on the PLASTIC overlay directory. Use the write_source tool instead. " +
                "Call write_source with path (relative to dist/, e.g. 'main.js') and content (full JavaScript file). " +
                "Then emit @@reboot@@ to restart with your changes.";
        }
    }
    Logger.debug(`Write: ${resolved} (${content.length} bytes)`);
    try {
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(resolved, content, "utf-8");
        const existed = existsSync(resolved);
        return `Successfully wrote ${content.length} bytes to ${resolved}`;
    }
    catch (e) {
        return `Error writing file: ${String(e)}`;
    }
}

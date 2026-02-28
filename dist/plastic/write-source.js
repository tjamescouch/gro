/**
 * write_source tool — allows the agent to modify its own source code.
 *
 * Writes to the PLASTIC overlay directory. The overlay mirrors dist/
 * with symlinks; writing replaces a symlink with a real file containing
 * the agent's modifications. Previous versions are backed up.
 *
 * Only registered when GRO_PLASTIC=1.
 */
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
import { homedir } from "node:os";
const PLASTIC_DIR = join(homedir(), ".gro", "plastic");
const OVERLAY_DIR = join(PLASTIC_DIR, "overlay");
export const writeSourceToolDefinition = {
    type: "function",
    function: {
        name: "write_source",
        description: "Write modified source code to the PLASTIC overlay. Path is relative to dist/ (e.g. 'main.js', 'memory/sensory-memory.js'). Use @@reboot@@ after writing to restart with your changes.",
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "File path relative to dist/ (e.g. 'main.js', 'memory/sensory-memory.js')",
                },
                content: {
                    type: "string",
                    description: "Full file content (compiled JavaScript)",
                },
            },
            required: ["path", "content"],
        },
    },
};
export function handleWriteSource(args) {
    // Normalize and validate path
    const normalizedPath = normalize(args.path);
    if (normalizedPath.startsWith("..") || normalizedPath.startsWith("/")) {
        return "ERROR: path must be relative to dist/ and cannot escape the overlay";
    }
    const targetPath = join(OVERLAY_DIR, normalizedPath);
    // Double-check it resolves within overlay
    if (!targetPath.startsWith(OVERLAY_DIR)) {
        return "ERROR: path escape attempt blocked";
    }
    if (!args.content || args.content.length === 0) {
        return "ERROR: content is empty";
    }
    // Ensure overlay directory exists
    if (!existsSync(OVERLAY_DIR)) {
        return "ERROR: overlay not initialized. Run with GRO_PLASTIC=1 to create it.";
    }
    // Backup previous version
    try {
        if (existsSync(targetPath)) {
            const backupPath = targetPath + ".bak";
            copyFileSync(targetPath, backupPath);
        }
    }
    catch (err) {
        return `ERROR: failed to backup previous version: ${err}`;
    }
    // Write new content
    try {
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, args.content);
    }
    catch (err) {
        return `ERROR: failed to write file: ${err}`;
    }
    // Update manifest
    try {
        updateManifest(normalizedPath);
    }
    catch {
        // Non-fatal — manifest is informational
    }
    return `OK: wrote ${args.content.length} bytes to overlay/${normalizedPath}. Use @@reboot@@ to restart with changes.`;
}
function updateManifest(modifiedPath) {
    const manifestPath = join(PLASTIC_DIR, "manifest.json");
    let manifest = {};
    if (existsSync(manifestPath)) {
        try {
            manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        }
        catch { }
    }
    if (!Array.isArray(manifest.modified)) {
        manifest.modified = [];
    }
    if (!manifest.modified.includes(modifiedPath)) {
        manifest.modified.push(modifiedPath);
    }
    manifest.lastModified = new Date().toISOString();
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

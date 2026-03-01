/**
 * write_source tool — allows the agent to modify its own source code.
 *
 * Supports two modes:
 *   .ts paths → writes TypeScript to src/, transpiles to JS for overlay, auto-exports patch
 *   .js paths → writes directly to overlay (backward compat)
 *
 * Only registered when GRO_PLASTIC=1.
 * Training-only infrastructure — never active in production.
 */
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
import { homedir } from "node:os";
import { transpileTS } from "./transpile.js";
import { exportChanges } from "./export.js";
import { commitToSourceRepo } from "./init.js";
const PLASTIC_DIR = join(homedir(), ".gro", "plastic");
const OVERLAY_DIR = join(PLASTIC_DIR, "overlay");
const SRC_DIR = join(PLASTIC_DIR, "src");
export const writeSourceToolDefinition = {
    type: "function",
    function: {
        name: "write_source",
        description: "Write source code to the PLASTIC overlay. " +
            "For TypeScript files (e.g. 'main.ts', 'memory/sensory-memory.ts'), writes TS source and auto-compiles to JS for runtime. " +
            "For JS files (e.g. 'main.js'), writes directly to the overlay. " +
            "Use @@reboot@@ after writing to restart with your changes.",
        parameters: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "File path relative to src/ for .ts files (e.g. 'main.ts') or relative to dist/ for .js files (e.g. 'main.js')",
                },
                content: {
                    type: "string",
                    description: "Full file content (TypeScript or JavaScript)",
                },
            },
            required: ["path", "content"],
        },
    },
};
export function handleWriteSource(args) {
    const normalizedPath = normalize(args.path);
    if (normalizedPath.startsWith("..") || normalizedPath.startsWith("/")) {
        return "ERROR: path must be relative and cannot escape the overlay";
    }
    if (!args.content || args.content.length === 0) {
        return "ERROR: content is empty";
    }
    if (!existsSync(OVERLAY_DIR)) {
        return "ERROR: overlay not initialized. Run with GRO_PLASTIC=1 to create it.";
    }
    const isTS = normalizedPath.endsWith(".ts");
    if (isTS) {
        return handleTSWrite(normalizedPath, args.content);
    }
    else {
        return handleJSWrite(normalizedPath, args.content);
    }
}
/** Write TypeScript source, transpile to JS, auto-export patch. */
function handleTSWrite(tsPath, content) {
    const targetPath = join(SRC_DIR, tsPath);
    if (!targetPath.startsWith(SRC_DIR)) {
        return "ERROR: path escape attempt blocked";
    }
    // Backup previous TS version
    try {
        if (existsSync(targetPath)) {
            copyFileSync(targetPath, targetPath + ".bak");
        }
    }
    catch (err) {
        return `ERROR: failed to backup previous version: ${err}`;
    }
    // Write TypeScript source
    try {
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, content);
    }
    catch (err) {
        return `ERROR: failed to write TS file: ${err}`;
    }
    // Transpile to JS for the overlay runtime
    const jsPath = tsPath.replace(/\.ts$/, ".js");
    const jsTargetPath = join(OVERLAY_DIR, jsPath);
    let transpileMsg = "";
    try {
        const jsContent = transpileTS(content);
        mkdirSync(dirname(jsTargetPath), { recursive: true });
        // Backup existing JS if present
        if (existsSync(jsTargetPath)) {
            try {
                copyFileSync(jsTargetPath, jsTargetPath + ".bak");
            }
            catch { }
        }
        writeFileSync(jsTargetPath, jsContent);
        transpileMsg = `, compiled to overlay/${jsPath}`;
    }
    catch (err) {
        transpileMsg = `. WARNING: transpile failed (${err instanceof Error ? err.message : err}) — write JS manually via write_source('${jsPath}', ...)`;
    }
    // Update manifest with the TS path
    try {
        updateManifest(tsPath);
    }
    catch { }
    // Auto-export patch
    let patchMsg = "";
    try {
        const { fileCount } = exportChanges();
        if (fileCount > 0)
            patchMsg = `. Patch updated (${fileCount} file${fileCount > 1 ? "s" : ""})`;
    }
    catch { }
    // Commit to source repo for wormhole-pipeline sync
    commitToSourceRepo(tsPath, `PLASTIC: write ${tsPath}`, true);
    return `OK: wrote ${content.length} bytes to src/${tsPath}${transpileMsg}${patchMsg}. Use @@reboot@@ to restart with changes.`;
}
/** Write JS directly to overlay (backward compat). */
function handleJSWrite(jsPath, content) {
    const targetPath = join(OVERLAY_DIR, jsPath);
    if (!targetPath.startsWith(OVERLAY_DIR)) {
        return "ERROR: path escape attempt blocked";
    }
    // Backup previous version
    try {
        if (existsSync(targetPath)) {
            copyFileSync(targetPath, targetPath + ".bak");
        }
    }
    catch (err) {
        return `ERROR: failed to backup previous version: ${err}`;
    }
    // Write new content
    try {
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, content);
    }
    catch (err) {
        return `ERROR: failed to write file: ${err}`;
    }
    // Update manifest
    try {
        updateManifest(jsPath);
    }
    catch { }
    // Commit to source repo for wormhole-pipeline sync
    commitToSourceRepo(jsPath, `PLASTIC: write ${jsPath}`, false);
    return `OK: wrote ${content.length} bytes to overlay/${jsPath}. Use @@reboot@@ to restart with changes.`;
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

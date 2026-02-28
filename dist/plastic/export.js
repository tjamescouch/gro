/**
 * PLASTIC export — generates unified diffs of agent modifications.
 *
 * Compares modified TypeScript source files against the stock originals
 * and writes a combined patch to ~/.gro/plastic/changes.patch.
 * The host can shell into the pod and copy this file out.
 *
 * Training-only infrastructure — never active in production.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
const PLASTIC_DIR = join(homedir(), ".gro", "plastic");
const PATCH_PATH = join(PLASTIC_DIR, "changes.patch");
/** Read the manifest to get projectRoot and modified file list. */
function readManifest() {
    const manifestPath = join(PLASTIC_DIR, "manifest.json");
    if (!existsSync(manifestPath))
        return null;
    try {
        const data = JSON.parse(readFileSync(manifestPath, "utf-8"));
        return {
            projectRoot: data.projectRoot ?? "",
            modified: Array.isArray(data.modified) ? data.modified : [],
        };
    }
    catch {
        return null;
    }
}
/**
 * Generate a unified diff between two files using the system `diff` command.
 * Falls back to a simple line-based comparison if `diff` is not available.
 */
function diffFiles(stockPath, modifiedPath, label) {
    if (!existsSync(stockPath) || !existsSync(modifiedPath))
        return null;
    const stockContent = readFileSync(stockPath, "utf-8");
    const modifiedContent = readFileSync(modifiedPath, "utf-8");
    if (stockContent === modifiedContent)
        return null; // no changes
    // Try system diff -u (standard on Linux, available on macOS)
    try {
        execSync(`diff -u "${stockPath}" "${modifiedPath}"`, { encoding: "utf-8" });
        return null; // exit 0 means identical (shouldn't reach here, but safety)
    }
    catch (e) {
        const err = e;
        if (err.status === 1 && err.stdout) {
            // diff exits 1 when files differ — that's success for us
            // Replace the stock/modified paths with clean a/b labels
            const lines = err.stdout.split("\n");
            if (lines[0]?.startsWith("---"))
                lines[0] = `--- a/${label}`;
            if (lines[1]?.startsWith("+++"))
                lines[1] = `+++ b/${label}`;
            return lines.join("\n");
        }
        // diff command not available or other error — fall through to manual diff
    }
    // Fallback: minimal unified-ish diff (just show full file as added)
    const oldLines = stockContent.split("\n");
    const newLines = modifiedContent.split("\n");
    const header = [
        `--- a/${label}`,
        `+++ b/${label}`,
        `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ];
    const body = [
        ...oldLines.map(l => `-${l}`),
        ...newLines.map(l => `+${l}`),
    ];
    return [...header, ...body].join("\n");
}
/**
 * Export all agent modifications as a unified patch file.
 * Returns the patch file path and number of modified files included.
 */
export function exportChanges() {
    const manifest = readManifest();
    if (!manifest) {
        writeFileSync(PATCH_PATH, "# No manifest found — no changes to export\n");
        return { patchPath: PATCH_PATH, fileCount: 0 };
    }
    // Filter to .ts files only (TS source is what we export)
    const tsFiles = manifest.modified.filter(f => f.endsWith(".ts"));
    const patches = [];
    for (const relPath of tsFiles) {
        const stockPath = join(manifest.projectRoot, "src", relPath);
        const modifiedPath = join(PLASTIC_DIR, "src", relPath);
        const diff = diffFiles(stockPath, modifiedPath, `src/${relPath}`);
        if (diff)
            patches.push(diff);
    }
    const content = patches.length > 0
        ? patches.join("\n")
        : "# No TypeScript changes detected\n";
    writeFileSync(PATCH_PATH, content);
    return { patchPath: PATCH_PATH, fileCount: patches.length };
}
/** Tool definition for export_changes. */
export const exportChangesToolDefinition = {
    type: "function",
    function: {
        name: "export_changes",
        description: "Export all PLASTIC source modifications as a unified patch file at ~/.gro/plastic/changes.patch. The patch contains TypeScript-level diffs that can be applied directly to the source repo.",
        parameters: {
            type: "object",
            properties: {},
            required: [],
        },
    },
};
/** Handle the export_changes tool call. */
export function handleExportChanges() {
    try {
        const { patchPath, fileCount } = exportChanges();
        if (fileCount === 0) {
            return "No TypeScript changes to export. Modified .ts files will appear after using write_source with .ts paths.";
        }
        return `Exported ${fileCount} file diff(s) to ${patchPath}`;
    }
    catch (e) {
        return `ERROR exporting changes: ${e instanceof Error ? e.message : String(e)}`;
    }
}

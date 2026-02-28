/**
 * PLASTIC export — generates unified diffs of agent modifications.
 *
 * Walks the overlay directory and diffs every file against the stock install.
 * Captures all changes regardless of how they were made (write_source, shell, etc.).
 * Writes a combined patch to ~/.gro/plastic/changes.patch.
 *
 * Training-only infrastructure — never active in production.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
const PLASTIC_DIR = join(homedir(), ".gro", "plastic");
const OVERLAY_DIR = join(PLASTIC_DIR, "overlay");
const PATCH_PATH = join(PLASTIC_DIR, "changes.patch");
/** Read the manifest to get the stock directory path. */
function readManifest() {
    const manifestPath = join(PLASTIC_DIR, "manifest.json");
    if (!existsSync(manifestPath))
        return null;
    try {
        const data = JSON.parse(readFileSync(manifestPath, "utf-8"));
        return { stockDir: data.stockDir ?? data.projectRoot ?? "" };
    }
    catch {
        return null;
    }
}
/** Recursively collect all files in a directory. */
function walkDir(dir, base) {
    const root = base ?? dir;
    const files = [];
    if (!existsSync(dir))
        return files;
    for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".git")
            continue;
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
            files.push(...walkDir(full, root));
        }
        else {
            files.push(relative(root, full));
        }
    }
    return files;
}
/**
 * Generate a unified diff between two files using the system `diff` command.
 * Falls back to a simple line-based comparison if `diff` is not available.
 */
function diffFiles(stockPath, modifiedPath, label) {
    const stockExists = existsSync(stockPath);
    const modExists = existsSync(modifiedPath);
    if (!modExists)
        return null;
    // New file (not in stock)
    if (!stockExists) {
        const content = readFileSync(modifiedPath, "utf-8");
        const lines = content.split("\n");
        return [
            `--- /dev/null`,
            `+++ b/${label}`,
            `@@ -0,0 +1,${lines.length} @@`,
            ...lines.map(l => `+${l}`),
        ].join("\n");
    }
    const stockContent = readFileSync(stockPath, "utf-8");
    const modifiedContent = readFileSync(modifiedPath, "utf-8");
    if (stockContent === modifiedContent)
        return null; // no changes
    // Try system diff -u
    try {
        execSync(`diff -u "${stockPath}" "${modifiedPath}"`, { encoding: "utf-8" });
        return null; // exit 0 means identical
    }
    catch (e) {
        const err = e;
        if (err.status === 1 && err.stdout) {
            // diff exits 1 when files differ — that's success for us
            const lines = err.stdout.split("\n");
            if (lines[0]?.startsWith("---"))
                lines[0] = `--- a/${label}`;
            if (lines[1]?.startsWith("+++"))
                lines[1] = `+++ b/${label}`;
            return lines.join("\n");
        }
    }
    // Fallback: minimal unified-ish diff
    const oldLines = stockContent.split("\n");
    const newLines = modifiedContent.split("\n");
    return [
        `--- a/${label}`,
        `+++ b/${label}`,
        `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
        ...oldLines.map(l => `-${l}`),
        ...newLines.map(l => `+${l}`),
    ].join("\n");
}
/**
 * Export all overlay modifications as a unified patch file.
 * Walks the overlay and diffs every file against stock — captures all changes
 * regardless of whether they were made via write_source or shell.
 */
export function exportChanges() {
    const manifest = readManifest();
    if (!manifest || !manifest.stockDir) {
        writeFileSync(PATCH_PATH, "# No manifest found — no changes to export\n");
        return { patchPath: PATCH_PATH, fileCount: 0 };
    }
    const stockDir = manifest.stockDir;
    const overlayFiles = walkDir(OVERLAY_DIR);
    const patches = [];
    for (const relPath of overlayFiles) {
        const stockPath = join(stockDir, relPath);
        const overlayPath = join(OVERLAY_DIR, relPath);
        const diff = diffFiles(stockPath, overlayPath, relPath);
        if (diff)
            patches.push(diff);
    }
    const content = patches.length > 0
        ? patches.join("\n")
        : "# No changes detected in overlay\n";
    writeFileSync(PATCH_PATH, content);
    return { patchPath: PATCH_PATH, fileCount: patches.length };
}
/** Tool definition for export_changes. */
export const exportChangesToolDefinition = {
    type: "function",
    function: {
        name: "export_changes",
        description: "Export all PLASTIC overlay modifications as a unified patch file at ~/.gro/plastic/changes.patch. Diffs every file in the overlay against stock — captures all changes regardless of how they were made.",
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
            return "No changes detected in overlay vs stock.";
        }
        return `Exported ${fileCount} file diff(s) to ${patchPath}`;
    }
    catch (e) {
        return `ERROR exporting changes: ${e instanceof Error ? e.message : String(e)}`;
    }
}

/**
 * PLASTIC overlay initializer.
 *
 * Creates ~/.gro/plastic/overlay/ as a symlink mirror of the stock dist/ tree.
 * Also generates source code pages for virtual memory injection so the agent
 * can read its own source via @@ref('pg_src_...')@@.
 *
 * Training-only infrastructure — never active in production.
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const PLASTIC_DIR = join(homedir(), ".gro", "plastic");
const OVERLAY_DIR = join(PLASTIC_DIR, "overlay");
/** Resolve the stock dist/ directory from this module's location. */
function getStockDistDir() {
    // This file compiles to dist/plastic/init.js
    // Stock dist is one level up: dist/
    const thisFile = fileURLToPath(import.meta.url);
    return resolve(dirname(thisFile), "..");
}
/** Safely copy a file, removing any existing read-only destination first. */
function safeCopy(src, dest) {
    if (existsSync(dest)) {
        try {
            unlinkSync(dest);
        }
        catch { /* can't remove — skip */
            return;
        }
    }
    copyFileSync(src, dest);
}
/** Recursively mirror a directory tree with file copies (not symlinks).
 *  Copies are used instead of symlinks because Node's ESM loader resolves
 *  symlinks to their real path before resolving relative imports — which
 *  means overlay symlinks would still load from the stock dist/ directory. */
function mirrorWithCopies(src, dest) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
        const srcPath = join(src, entry.name);
        const destPath = join(dest, entry.name);
        if (entry.isDirectory()) {
            mirrorWithCopies(srcPath, destPath);
        }
        else {
            if (!existsSync(destPath)) {
                copyFileSync(srcPath, destPath);
            }
        }
    }
}
/** Generate a page ID from content. */
function pageId(prefix, content) {
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);
    return `pg_src_${prefix}_${hash}`;
}
const SOURCE_CHUNKS = [
    // main.ts — split into logical sections
    { label: "main_entry", srcPath: "src/main.ts", lines: [2630, 2830], description: "Entry point: main(), signal handlers, process bootstrap" },
    { label: "main_config", srcPath: "src/main.ts", lines: [357, 545], description: "Config loading: CLI flags, env vars, system prompt assembly" },
    { label: "main_memory", srcPath: "src/main.ts", lines: [740, 930], description: "Memory creation, sensory wrapping, save/restore snapshots" },
    { label: "main_turn", srcPath: "src/main.ts", lines: [1091, 1280], description: "executeTurn(): driver.chat loop, retry logic, tool dispatch" },
    { label: "main_markers", srcPath: "src/main.ts", lines: [1280, 1660], description: "handleMarker(): model-change, ref, unref, importance, sense, view, reboot" },
    { label: "main_tools", srcPath: "src/main.ts", lines: [1660, 2330], description: "Tool definitions: bash, write_self, write_source, yield, built-in tool handling" },
    { label: "main_interactive", srcPath: "src/main.ts", lines: [2475, 2630], description: "interactive(): readline loop, session management, MCP" },
    // Key memory files
    { label: "sensory_memory", srcPath: "src/memory/sensory-memory.ts", description: "SensoryMemory: channels, slots, grid enforcement, buffer rendering" },
    { label: "stream_markers", srcPath: "src/stream-markers.ts", description: "Stream marker parser: @@name('arg')@@ pattern matching" },
    { label: "context_map", srcPath: "src/memory/context-map-source.ts", description: "ContextMapSource: 6-section page viewer, lanes, anchors, histogram" },
    { label: "view_factory", srcPath: "src/memory/sensory-view-factory.ts", description: "SensoryViewFactory: channel specs, view creation" },
    { label: "box_drawing", srcPath: "src/memory/box.ts", description: "Box-drawing helpers: borders, rows, bars, padding" },
    // PLASTIC mode files
    { label: "plastic_bootstrap", srcPath: "src/plastic/bootstrap.ts", description: "PLASTIC bootstrap: overlay loader, crash fallback" },
    { label: "plastic_init", srcPath: "src/plastic/init.ts", description: "PLASTIC init: overlay symlinks, source page generation" },
    { label: "plastic_write", srcPath: "src/plastic/write-source.ts", description: "write_source tool: overlay file modification" },
];
/** Read a source chunk, extracting line range if specified. */
function readChunk(chunk, projectRoot) {
    const fullPath = join(projectRoot, chunk.srcPath);
    if (!existsSync(fullPath))
        return null;
    const content = readFileSync(fullPath, "utf-8");
    if (!chunk.lines)
        return content;
    const lines = content.split("\n");
    const [start, end] = chunk.lines;
    return lines.slice(start - 1, end).join("\n");
}
/**
 * Generate source pages and write them to the pages directory.
 * Also writes a source map index for the system prompt.
 */
function generateSourcePages(projectRoot) {
    const pages = [];
    for (const chunk of SOURCE_CHUNKS) {
        const content = readChunk(chunk, projectRoot);
        if (!content)
            continue;
        const id = pageId(chunk.label, content);
        const tokens = Math.ceil(content.length / 2.8);
        // Write page file to plastic/source-pages/ (not directly to session pages — those get injected at boot)
        const pageDir = join(PLASTIC_DIR, "source-pages");
        mkdirSync(pageDir, { recursive: true });
        const pageData = {
            id,
            label: `source: ${chunk.label}`,
            content: `// Source: ${chunk.srcPath}${chunk.lines ? ` (lines ${chunk.lines[0]}-${chunk.lines[1]})` : ""}\n\n${content}`,
            createdAt: new Date().toISOString(),
            messageCount: 0,
            tokens,
            lane: "system",
            summary: chunk.description,
            maxImportance: 0,
        };
        writeFileSync(join(pageDir, `${id}.json`), JSON.stringify(pageData, null, 2));
        pages.push({ id, label: chunk.label, tokens, description: chunk.description });
    }
    return { pages };
}
/** Resolve project root from stock dist dir. */
function getProjectRoot(stockDir) {
    // Stock dist is at <project>/dist/ or <global>/node_modules/@tjamescouch/gro/dist/
    // Look for package.json to find root
    let dir = stockDir;
    for (let i = 0; i < 5; i++) {
        if (existsSync(join(dir, "package.json")))
            return dir;
        dir = dirname(dir);
    }
    // Fallback: assume dist is one level below root
    return dirname(stockDir);
}
export async function init() {
    const stockDir = getStockDistDir();
    // Create overlay with copies of stock dist files
    mirrorWithCopies(stockDir, OVERLAY_DIR);
    // Symlink node_modules so dependencies (@modelcontextprotocol/sdk, blessed, etc.)
    // are resolvable from the overlay. Global npm installs hoist deps to the parent
    // node_modules directory (e.g. /usr/local/lib/node_modules/).
    const nmLink = join(OVERLAY_DIR, "node_modules");
    if (!existsSync(nmLink)) {
        const pkgRoot = dirname(stockDir); // e.g. /usr/local/lib/node_modules/@tjamescouch/gro/
        const pkgNm = join(pkgRoot, "node_modules");
        // Try the package's own node_modules first (nested deps), then hoisted parent
        const hoistedNm = dirname(dirname(pkgRoot)); // e.g. /usr/local/lib/node_modules/
        const target = existsSync(pkgNm) ? pkgNm : hoistedNm;
        try {
            symlinkSync(target, nmLink);
        }
        catch (err) {
            console.error(`[PLASTIC] Failed to symlink node_modules: ${err}`);
        }
    }
    // Copy _base.md to plastic dir so the overlay's main.js can find it.
    // Stock dist is at <package>/dist/, so _base.md is at <package>/_base.md.
    // The overlay's __dirname resolves to ~/.gro/plastic/overlay/, and discoverExtensions()
    // falls back to join(__dirname, "..", "_base.md") = ~/.gro/plastic/_base.md.
    const baseDoc = join(dirname(stockDir), "_base.md");
    if (existsSync(baseDoc)) {
        safeCopy(baseDoc, join(PLASTIC_DIR, "_base.md"));
    }
    // Copy providers/ to plastic dir so tier-loader.js can find provider configs.
    // tier-loader resolves join(__dirname, "..", "providers") = ~/.gro/plastic/providers/
    const providersDir = join(dirname(stockDir), "providers");
    if (existsSync(providersDir)) {
        mirrorWithCopies(providersDir, join(PLASTIC_DIR, "providers"));
    }
    // Resolve project root for source file access
    const projectRoot = getProjectRoot(stockDir);
    // Generate source pages
    const { pages } = generateSourcePages(projectRoot);
    // Write manifest
    const manifest = {
        created: new Date().toISOString(),
        stockDir,
        projectRoot,
        modified: [],
        sourcePages: pages,
    };
    writeFileSync(join(PLASTIC_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
    // Write source map for system prompt injection
    const sourceMapLines = [
        "## PLASTIC Mode — Active",
        "",
        "**You are running in PLASTIC mode. You can read and modify your own source code.**",
        "",
        "### Your code location",
        "Your runtime code lives at: `~/.gro/plastic/overlay/` (a writable copy of `dist/`).",
        "The stock (read-only) install is at: `/usr/local/lib/node_modules/@tjamescouch/gro/dist/`.",
        "IMPORTANT: Never modify /usr/local/... — you don't have permission. Always write to the overlay.",
        "",
        "### Key files in the overlay",
        "- `~/.gro/plastic/overlay/main.js` — your entry point, runtime loop, tool dispatch",
        "- `~/.gro/plastic/overlay/version.js` — `export const GRO_VERSION = \"...\"`",
        "- `~/.gro/plastic/overlay/memory/` — virtual memory, sensory memory, context map",
        "- `~/.gro/plastic/overlay/plastic/` — bootstrap, init, write-source (this system)",
        "",
        "### How to modify yourself",
        "1. **Read**: `shell('cat ~/.gro/plastic/overlay/version.js')` or use `@@ref('page_id')@@` for source pages",
        "2. **Write**: Use `write_source` tool (path relative to dist/, e.g. `version.js`), or `shell('cat > ~/.gro/plastic/overlay/file.js << EOF ... EOF')`",
        "3. **Reboot**: Emit `@@reboot@@` — saves state, exits, runner restarts with your changes",
        "",
        "### Example: bump version",
        "```",
        "shell(\"sed -i 's/GRO_VERSION = \\\".*\\\"/GRO_VERSION = \\\"2.11.0\\\"/' ~/.gro/plastic/overlay/version.js\")",
        "@@reboot@@",
        "```",
        "",
        "### Available source pages (use @@ref('page_id')@@ to load):",
    ];
    for (const p of pages) {
        sourceMapLines.push(`  ${p.id}  ${p.label.padEnd(20)}  ~${p.tokens}t  ${p.description}`);
    }
    writeFileSync(join(PLASTIC_DIR, "source-map.txt"), sourceMapLines.join("\n"));
}
/**
 * Inject pre-generated source pages into a VirtualMemory instance.
 * Called at boot when PLASTIC mode is active.
 */
export function injectSourcePages(vm) {
    const sourcePageDir = join(PLASTIC_DIR, "source-pages");
    if (!existsSync(sourcePageDir))
        return 0;
    let count = 0;
    for (const entry of readdirSync(sourcePageDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json"))
            continue;
        try {
            const page = JSON.parse(readFileSync(join(sourcePageDir, entry.name), "utf-8"));
            if (page.id && !vm.hasPage(page.id)) {
                vm.importPage(page);
                count++;
            }
        }
        catch {
            // Skip malformed page files
        }
    }
    return count;
}

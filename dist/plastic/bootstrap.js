/**
 * PLASTIC mode bootstrap — loads gro from overlay directory.
 *
 * When GRO_PLASTIC=1, the stock entry point diverts here.
 * We try to import main() from the overlay (which may contain
 * agent-modified files). On failure, fall back to stock code.
 *
 * Training-only infrastructure — never active in production.
 */
import { existsSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
const PLASTIC_DIR = join(homedir(), ".gro", "plastic");
const OVERLAY_DIR = join(PLASTIC_DIR, "overlay");
const CRASH_LOG = join(PLASTIC_DIR, "crash.log");
/** Read GRO_VERSION from a version.js file. */
function readVersionFrom(dir) {
    const vFile = join(dir, "version.js");
    if (!existsSync(vFile))
        return null;
    const m = readFileSync(vFile, "utf-8").match(/GRO_VERSION\s*=\s*"([^"]+)"/);
    return m ? m[1] : null;
}
export async function boot() {
    mkdirSync(PLASTIC_DIR, { recursive: true });
    // Check if overlay is stale (stock version upgraded since overlay was created).
    // Stock dist/ is one level up from this file (dist/plastic/bootstrap.js → dist/).
    const stockDir = dirname(dirname(fileURLToPath(import.meta.url)));
    if (existsSync(OVERLAY_DIR)) {
        const stockVersion = readVersionFrom(stockDir);
        const overlayVersion = readVersionFrom(OVERLAY_DIR);
        if (stockVersion && overlayVersion && stockVersion !== overlayVersion) {
            // Only wipe when stock is NEWER than overlay (genuine npm upgrade).
            // If overlay >= stock, the agent modified it intentionally — preserve it.
            const sv = stockVersion.split(".").map(Number);
            const ov = overlayVersion.split(".").map(Number);
            const stockIsNewer = sv[0] > ov[0]
                || (sv[0] === ov[0] && sv[1] > ov[1])
                || (sv[0] === ov[0] && sv[1] === ov[1] && sv[2] > ov[2]);
            if (stockIsNewer) {
                console.log(`[PLASTIC] Stock upgraded ${overlayVersion} → ${stockVersion} — re-initializing overlay.`);
                try {
                    rmSync(OVERLAY_DIR, { recursive: true, force: true });
                }
                catch { }
            }
            else {
                console.log(`[PLASTIC] Overlay version ${overlayVersion} >= stock ${stockVersion} — preserving agent modifications.`);
            }
        }
    }
    // Initialize overlay if it doesn't exist (or was just wiped)
    if (!existsSync(OVERLAY_DIR)) {
        console.log("[PLASTIC] No overlay found — initializing...");
        const { init } = await import("./init.js");
        await init();
        console.log("[PLASTIC] Overlay created.");
    }
    // Try loading from overlay
    const overlayMain = join(OVERLAY_DIR, "main.js");
    if (!existsSync(overlayMain)) {
        console.error("[PLASTIC] overlay/main.js not found — falling back to stock");
        await runStock();
        return;
    }
    try {
        console.log("[PLASTIC] Booting from overlay...");
        // Signal to the overlay's main.js that we're already inside the overlay —
        // prevents it from re-entering the bootstrap divert at module load time
        process.env.GRO_PLASTIC_BOOTED = "1";
        const mod = await import(pathToFileURL(overlayMain).href);
        if (typeof mod.main !== "function") {
            throw new Error("overlay/main.js does not export main()");
        }
        await mod.main();
    }
    catch (err) {
        const errObj = err instanceof Error ? err : new Error(String(err));
        // Log crash
        const entry = `${new Date().toISOString()}\n${errObj.message}\n${errObj.stack ?? ""}\n---\n`;
        try {
            writeFileSync(CRASH_LOG, entry, { flag: "a" });
        }
        catch { }
        console.error(`[PLASTIC] Overlay crashed: ${errObj.message}`);
        console.error("[PLASTIC] Wiping corrupted overlay — will re-init on next boot.");
        try {
            rmSync(OVERLAY_DIR, { recursive: true, force: true });
        }
        catch { }
        console.error("[PLASTIC] Falling back to stock code.");
        await runStock();
    }
}
async function runStock() {
    // Dynamic import of the stock main module.
    // bootstrap.js lives in dist/plastic/, stock main.js is at dist/main.js
    const stock = await import("../main.js");
    await stock.main();
}

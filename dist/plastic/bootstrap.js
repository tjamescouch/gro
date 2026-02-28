/**
 * PLASTIC mode bootstrap — loads gro from overlay directory.
 *
 * When GRO_PLASTIC=1, the stock entry point diverts here.
 * We try to import main() from the overlay (which may contain
 * agent-modified files). On failure, fall back to stock code.
 *
 * Training-only infrastructure — never active in production.
 */
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
const PLASTIC_DIR = join(homedir(), ".gro", "plastic");
const OVERLAY_DIR = join(PLASTIC_DIR, "overlay");
const CRASH_LOG = join(PLASTIC_DIR, "crash.log");
export async function boot() {
    mkdirSync(PLASTIC_DIR, { recursive: true });
    // Initialize overlay if it doesn't exist
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

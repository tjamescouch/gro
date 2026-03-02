/**
 * reboot tool — PLASTIC mode process restart via tool call.
 *
 * More reliable than the @@reboot@@ stream marker since tool calls are
 * parsed deterministically. Saves warm state to the supervisor, writes
 * the rapid-resume marker, then exits with code 75 (reload).
 *
 * Only registered when GRO_PLASTIC=1.
 * Training-only infrastructure — never active in production.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Logger } from "../logger.js";
export const rebootToolDefinition = {
    type: "function",
    function: {
        name: "reboot",
        description: "Restart the PLASTIC agent process to pick up overlay code changes. " +
            "Saves warm state (messages, page state) so you resume exactly where you left off. " +
            "Call this after edit_source/write_source to reload with your modifications.",
        parameters: {
            type: "object",
            properties: {
                reason: {
                    type: "string",
                    description: "Brief reason for rebooting (logged to stderr)",
                },
            },
        },
    },
};
/**
 * Trigger a PLASTIC reboot. This function schedules the exit — the caller
 * should return the result string as the tool response, then the process
 * exits before the next API round-trip.
 *
 * @param args - Tool arguments ({ reason?: string })
 * @param saveAndExit - Callback that saves warm state and exits(75).
 *   Provided by the executeTurn caller since it has access to memory/config.
 */
export function handleReboot(args, saveAndExit) {
    const reason = args.reason || "reboot requested";
    Logger.telemetry(`[PLASTIC] Reboot tool called: ${reason}`);
    // Write rapid-resume marker so the next boot auto-fires a turn
    try {
        const rebootMarker = join(homedir(), ".gro", "plastic", "reboot-pending");
        writeFileSync(rebootMarker, new Date().toISOString());
    }
    catch { }
    // Schedule the save+exit on next tick so the tool result is returned first
    setImmediate(saveAndExit);
    return `Rebooting: ${reason}. Warm state will be preserved. You will resume automatically.`;
}

import { cleanupOldSessions } from "../session.js";
import { Logger } from "../logger.js";
export const cleanupSessionsToolDefinition = {
    name: "cleanup_sessions",
    description: "Remove orphaned sessions older than 48 hours. Returns count of deleted sessions.",
    input_schema: {
        type: "object",
        properties: {
            max_age_hours: {
                type: "number",
                description: "Maximum age in hours (default: 48)",
                default: 48,
            },
        },
    },
};
export async function executeCleanupSessions(args) {
    const hours = args.max_age_hours ?? 48;
    const ms = hours * 60 * 60 * 1000;
    try {
        const deleted = cleanupOldSessions(ms);
        const msg = `Cleanup complete: removed ${deleted} session(s) older than ${hours}h`;
        Logger.info(msg);
        return msg;
    }
    catch (err) {
        const msg = `Cleanup failed: ${err instanceof Error ? err.message : String(err)}`;
        Logger.error(msg);
        return msg;
    }
}

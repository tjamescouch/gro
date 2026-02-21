import { cleanupOldSessions } from "../session.js";
import { Logger } from "../logger.js";

export const cleanupSessionsToolDefinition = {
  type: "function" as const,
  function: {
    name: "cleanup_sessions",
    description:
      "Remove orphaned sessions older than 48 hours. Returns count of deleted sessions.",
    parameters: {
      type: "object" as const,
      properties: {
        max_age_hours: {
          type: "number",
          description: "Maximum age in hours (default: 48)",
          default: 48,
        },
      },
    },
  },
};

export async function executeCleanupSessions(args: {
  max_age_hours?: number;
}): Promise<string> {
  const hours = args.max_age_hours ?? 48;
  const ms = hours * 60 * 60 * 1000;

  try {
    const deleted = cleanupOldSessions(ms);
    const msg = `Cleanup complete: removed ${deleted} session(s) older than ${hours}h`;
    Logger.info(msg);
    return msg;
  } catch (err) {
    const msg = `Cleanup failed: ${err instanceof Error ? err.message : String(err)}`;
    Logger.error(msg);
    return msg;
  }
}

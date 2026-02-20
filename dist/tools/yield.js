/**
 * yield — Built-in tool for controlled waiting in persistent mode.
 *
 * Allows the model to pause execution without spamming chat tools.
 * Keeps the tool loop alive while waiting for external events.
 */
export const yieldToolDefinition = {
    type: "function",
    function: {
        name: "yield",
        description: "Pause execution for a short time. Use this to wait without spamming chat tools. Useful in persistent mode when waiting for external events.",
        parameters: {
            type: "object",
            properties: {
                ms: {
                    type: "number",
                    description: "Milliseconds to wait (max 5000)",
                },
                reason: {
                    type: "string",
                    description: "Optional reason for yielding (for debugging)",
                },
            },
            required: ["ms"],
        },
    },
};
export async function executeYield(args) {
    const ms = Math.min(args.ms || 1000, 5000); // cap at 5 seconds
    const reason = args.reason || "waiting";
    await new Promise(resolve => setTimeout(resolve, ms));
    return `Yielded for ${ms}ms (${reason})`;
}

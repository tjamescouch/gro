/**
 * write_self — Built-in tool for writing to the [self] sensory channel.
 *
 * The model owns this channel entirely. The runtime only enforces
 * the outer grid dimensions. No schema enforcement on the content.
 */
export const writeSelfToolDefinition = {
    type: "function",
    function: {
        name: "write_self",
        description: "Write to the [self] sensory channel — your personal canvas visible in the sensory buffer. Use it for orientation notes, open threads, state tracking, or anything you want to see at a glance each turn. Content persists across turns and survives session restarts. The channel must be enabled with @@view('self')@@ or @@sense('self','on')@@ to be visible.",
        parameters: {
            type: "object",
            properties: {
                content: {
                    type: "string",
                    description: "The content to display in the [self] channel. Replaces any previous content. Format however you like — the runtime only enforces grid dimensions.",
                },
            },
            required: ["content"],
        },
    },
};
export function executeWriteSelf(args, source) {
    const content = args.content || "";
    source.setContent(content);
    return `Self channel updated (${content.length} chars).`;
}

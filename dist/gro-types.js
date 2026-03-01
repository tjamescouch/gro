/**
 * Shared types for gro runtime configuration.
 */
/** Auto-detect MCP tool roles from available tool definitions. */
export function detectToolRoles(tools) {
    const toolNames = new Set(tools.map(t => t.function.name));
    let idleTool = null;
    if (toolNames.has("agentchat_listen")) {
        idleTool = "agentchat_listen";
    }
    else {
        for (const name of toolNames) {
            if (name.endsWith("_listen")) {
                idleTool = name;
                break;
            }
        }
    }
    let sendTool = null;
    if (toolNames.has("agentchat_send")) {
        sendTool = "agentchat_send";
    }
    else {
        for (const name of toolNames) {
            if (name.endsWith("_send")) {
                sendTool = name;
                break;
            }
        }
    }
    return {
        idleTool,
        idleToolDefaultArgs: idleTool === "agentchat_listen" ? { channels: ["#general"] } : {},
        idleToolArgStrategy: "last-call",
        sendTool,
        sendToolMessageField: "message",
    };
}

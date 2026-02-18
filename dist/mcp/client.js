/**
 * MCP client — connects to MCP servers, discovers tools, routes tool calls.
 * Compatible with Claude Code's ~/.claude/settings.json mcpServers config.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Logger } from "../logger.js";
import { groError, asError, errorLogFields } from "../errors.js";
export class McpManager {
    constructor() {
        this.servers = new Map();
    }
    /**
     * Connect to all configured MCP servers and discover their tools.
     */
    async connectAll(configs) {
        const entries = Object.entries(configs);
        if (entries.length === 0)
            return;
        Logger.debug(`Connecting to ${entries.length} MCP server(s)...`);
        await Promise.all(entries.map(([name, cfg]) => this.connectOne(name, cfg).catch((e) => {
            const ge = groError("mcp_error", `MCP server "${name}" failed to connect: ${asError(e).message}`, {
                retryable: true,
                cause: e,
            });
            Logger.warn(ge.message, errorLogFields(ge));
        })));
    }
    async connectOne(name, cfg) {
        const transport = new StdioClientTransport({
            command: cfg.command,
            args: cfg.args ?? [],
            env: { ...process.env, ...cfg.env },
            cwd: cfg.cwd,
            stderr: "pipe",
        });
        const client = new Client({ name: "gro", version: "0.2.0" }, { capabilities: {} });
        await client.connect(transport);
        // Discover tools
        const toolsResult = await client.listTools();
        const tools = (toolsResult.tools ?? []).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            serverName: name,
        }));
        const timeout = cfg.timeout ?? 60 * 60 * 1000; // default: 1 hour
        this.servers.set(name, { name, client, transport, tools, timeout });
        Logger.debug(`MCP "${name}": ${tools.length} tool(s) available`);
    }
    /**
     * Get all discovered tools in OpenAI function-calling format.
     */
    getToolDefinitions() {
        const defs = [];
        for (const server of this.servers.values()) {
            for (const tool of server.tools) {
                defs.push({
                    type: "function",
                    function: {
                        name: tool.name,
                        description: tool.description ?? "",
                        parameters: tool.inputSchema ?? { type: "object", properties: {} },
                    },
                });
            }
        }
        return defs;
    }
    /**
     * Execute a tool call by routing it to the correct MCP server.
     */
    async callTool(name, args) {
        // Find which server provides this tool
        for (const server of this.servers.values()) {
            const tool = server.tools.find(t => t.name === name);
            if (tool) {
                try {
                    const result = await server.client.callTool({ name, arguments: args }, undefined, { timeout: server.timeout });
                    // Extract text content from result
                    if (Array.isArray(result.content)) {
                        return result.content
                            .map((c) => {
                            if (c.type === "text")
                                return c.text;
                            return JSON.stringify(c);
                        })
                            .join("\n");
                    }
                    return JSON.stringify(result);
                }
                catch (e) {
                    const err = asError(e);
                    const ge = groError("mcp_error", `MCP tool "${name}" (server: ${server.name}) failed: ${err.message}`, {
                        retryable: true,
                        cause: e,
                    });
                    Logger.error(`MCP tool call failed [${server.name}/${name}]:`, errorLogFields(ge));
                    throw ge;
                }
            }
        }
        const ge = groError("mcp_error", `No MCP server provides tool "${name}"`, { retryable: false });
        Logger.error(ge.message, errorLogFields(ge));
        throw ge;
    }
    /**
     * Check if a tool name is provided by any connected MCP server.
     */
    hasTool(name) {
        for (const server of this.servers.values()) {
            if (server.tools.some(t => t.name === name))
                return true;
        }
        return false;
    }
    /**
     * Disconnect all MCP servers.
     */
    async disconnectAll() {
        for (const server of this.servers.values()) {
            try {
                await server.client.close();
            }
            catch (e) {
                Logger.debug(`MCP server "${server.name}" close error: ${asError(e).message}`);
            }
        }
        this.servers.clear();
    }
}

/**
 * MCP client — connects to MCP servers, discovers tools, routes tool calls.
 * Compatible with Claude Code's ~/.claude/settings.json mcpServers config.
 *
 * Requires: @modelcontextprotocol/sdk (optional peer dependency).
 * If not installed, MCP features are disabled gracefully.
 */

import { Logger } from "../logger.js";

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: any;
  serverName: string;
}

interface ConnectedServer {
  name: string;
  client: any;
  transport: any;
  tools: McpTool[];
}

export class McpManager {
  private servers = new Map<string, ConnectedServer>();

  /** Connect to all configured MCP servers and discover their tools. */
  async connectAll(configs: Record<string, McpServerConfig>): Promise<void> {
    const entries = Object.entries(configs);
    if (entries.length === 0) return;

    Logger.debug(`Connecting to ${entries.length} MCP server(s)...`);
    await Promise.all(
      entries.map(([name, cfg]) =>
        this.connectOne(name, cfg).catch((e: Error) => {
          Logger.warn(`MCP server "${name}" failed to connect: ${e.message}`);
        })
      )
    );
  }

  private async connectOne(name: string, cfg: McpServerConfig): Promise<void> {
    // Dynamic import — gracefully handle missing SDK
    let Client: any;
    let StdioClientTransport: any;
    try {
      // @ts-ignore — optional peer dependency, handled by try/catch
      const clientMod = await import("@modelcontextprotocol/sdk/client/index.js");
      // @ts-ignore — optional peer dependency, handled by try/catch
      const transportMod = await import("@modelcontextprotocol/sdk/client/stdio.js");
      Client = clientMod.Client;
      StdioClientTransport = transportMod.StdioClientTransport;
    } catch {
      Logger.warn(`MCP SDK not installed — skipping server "${name}". Install @modelcontextprotocol/sdk to enable.`);
      return;
    }

    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...process.env, ...cfg.env },
      cwd: cfg.cwd,
      stderr: "pipe",
    });

    const client = new Client(
      { name: "gro", version: "0.3.0" },
      { capabilities: {} }
    );
    await client.connect(transport);

    const toolsResult = await client.listTools();
    const tools: McpTool[] = (toolsResult.tools ?? []).map((t: any) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      serverName: name,
    }));

    this.servers.set(name, { name, client, transport, tools });
    Logger.debug(`MCP "${name}": ${tools.length} tool(s) available`);
  }

  /** Get all discovered tools in OpenAI function-calling format. */
  getToolDefinitions(): any[] {
    const defs: any[] = [];
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

  /** Execute a tool call by routing it to the correct MCP server. */
  async callTool(name: string, args: any): Promise<string> {
    for (const server of this.servers.values()) {
      const tool = server.tools.find((t: McpTool) => t.name === name);
      if (tool) {
        const result = await server.client.callTool({ name, arguments: args });
        if (Array.isArray(result.content)) {
          return result.content
            .map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c)))
            .join("\n");
        }
        return JSON.stringify(result);
      }
    }
    throw new Error(`No MCP server provides tool "${name}"`);
  }

  /** Check if a tool name is provided by any connected MCP server. */
  hasTool(name: string): boolean {
    for (const server of this.servers.values()) {
      if (server.tools.some((t: McpTool) => t.name === name)) return true;
    }
    return false;
  }

  /** Disconnect all MCP servers. */
  async disconnectAll(): Promise<void> {
    for (const server of this.servers.values()) {
      try {
        await server.client.close();
      } catch {}
    }
    this.servers.clear();
  }
}

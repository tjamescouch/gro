/**
 * MCP client — connects to MCP servers, discovers tools, routes tool calls.
 * Compatible with Claude Code's ~/.claude/settings.json mcpServers config.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Logger } from "../logger.js";
import { groError, asError, errorLogFields } from "../errors.js";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: any;
  /** Which MCP server provides this tool. */
  serverName: string;
}

interface ConnectedServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: McpTool[];
}

export class McpManager {
  private servers = new Map<string, ConnectedServer>();

  /**
   * Connect to all configured MCP servers and discover their tools.
   */
  async connectAll(configs: Record<string, McpServerConfig>): Promise<void> {
    const entries = Object.entries(configs);
    if (entries.length === 0) return;

    Logger.debug(`Connecting to ${entries.length} MCP server(s)...`);

    await Promise.all(
      entries.map(([name, cfg]) => this.connectOne(name, cfg).catch((e: unknown) => {
        const ge = groError("mcp_error", `MCP server "${name}" failed to connect: ${asError(e).message}`, {
          retryable: true,
          cause: e,
        });
        Logger.warn(ge.message, errorLogFields(ge));
      }))
    );
  }

  private async connectOne(name: string, cfg: McpServerConfig): Promise<void> {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...process.env, ...cfg.env } as Record<string, string>,
      cwd: cfg.cwd,
      stderr: "pipe",
    });

    const client = new Client(
      { name: "gro", version: "0.2.0" },
      { capabilities: {} }
    );

    await client.connect(transport);

    // Discover tools
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

  /**
   * Get all discovered tools in OpenAI function-calling format.
   */
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

  /**
   * Execute a tool call by routing it to the correct MCP server.
   */
  async callTool(name: string, args: Record<string, any>): Promise<string> {
    // Find which server provides this tool
    for (const server of this.servers.values()) {
      const tool = server.tools.find(t => t.name === name);
      if (tool) {
        const result = await server.client.callTool({ name, arguments: args });
        // Extract text content from result
        if (Array.isArray(result.content)) {
          return result.content
            .map((c: any) => {
              if (c.type === "text") return c.text;
              return JSON.stringify(c);
            })
            .join("\n");
        }
        return JSON.stringify(result);
      }
    }
    throw new Error(`No MCP server provides tool "${name}"`);
  }

  /**
   * Check if a tool name is provided by any connected MCP server.
   */
  hasTool(name: string): boolean {
    for (const server of this.servers.values()) {
      if (server.tools.some(t => t.name === name)) return true;
    }
    return false;
  }

  /**
   * Disconnect all MCP servers.
   */
  async disconnectAll(): Promise<void> {
    for (const server of this.servers.values()) {
      try { await server.client.close(); } catch {}
    }
    this.servers.clear();
  }
}

/**
 * Plugin tool registry — lets plugins register tools that gro merges
 * into the tool list and dispatches alongside built-in tools.
 *
 * Follows the singleton pattern used by MemoryRegistry.
 */

/** A tool contributed by a plugin. */
export interface PluginTool {
  /** Tool name (must be unique across all plugins + built-ins). */
  name: string;
  /** OpenAI-style function tool definition. */
  definition: Record<string, unknown>;
  /** Execute the tool. Returns the result string. */
  execute: (args: Record<string, unknown>) => string | Promise<string>;
}

class ToolRegistry {
  private tools = new Map<string, PluginTool>();

  /** Register a plugin tool. Throws if name already taken. */
  register(tool: PluginTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Plugin tool '${tool.name}' is already registered.`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Check whether a tool name is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Get a registered tool by name. */
  get(name: string): PluginTool | undefined {
    return this.tools.get(name);
  }

  /** Return tool definitions for all registered tools (to merge into the tools array). */
  getToolDefinitions(): Record<string, unknown>[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /**
   * Attempt to call a tool by name.
   * Returns `undefined` if the tool is not registered (fall through to other dispatchers).
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string | undefined> {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    return await tool.execute(args);
  }
}

export const toolRegistry = new ToolRegistry();

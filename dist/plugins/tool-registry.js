/**
 * Plugin tool registry — lets plugins register tools that gro merges
 * into the tool list and dispatches alongside built-in tools.
 *
 * Follows the singleton pattern used by MemoryRegistry.
 */
class ToolRegistry {
    constructor() {
        this.tools = new Map();
    }
    /** Register a plugin tool. Throws if name already taken. */
    register(tool) {
        if (this.tools.has(tool.name)) {
            throw new Error(`Plugin tool '${tool.name}' is already registered.`);
        }
        this.tools.set(tool.name, tool);
    }
    /** Check whether a tool name is registered. */
    has(name) {
        return this.tools.has(name);
    }
    /** Get a registered tool by name. */
    get(name) {
        return this.tools.get(name);
    }
    /** Return tool definitions for all registered tools (to merge into the tools array). */
    getToolDefinitions() {
        return Array.from(this.tools.values()).map((t) => t.definition);
    }
    /**
     * Attempt to call a tool by name.
     * Returns `undefined` if the tool is not registered (fall through to other dispatchers).
     */
    async callTool(name, args) {
        const tool = this.tools.get(name);
        if (!tool)
            return undefined;
        return await tool.execute(args);
    }
}
export const toolRegistry = new ToolRegistry();

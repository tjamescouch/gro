/**
 * Visage plugin — registers avatar/persona tools with the plugin tool registry.
 *
 * `discover_avatar` calls the visage server to learn what the avatar body can do.
 */

import { toolRegistry } from "../tool-registry.js";

export function registerVisageTools(serverUrl: string): void {
  const base = serverUrl.replace(/\/+$/, "");

  toolRegistry.register({
    name: "discover_avatar",
    definition: {
      type: "function",
      function: {
        name: "discover_avatar",
        description:
          "Discover what the connected avatar body can do. " +
          "Returns a JSON capabilities manifest describing available expressions, " +
          "gestures, and other controllable features.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    execute: async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(`${base}/api/avatar/capabilities`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          return `Error: visage server returned ${res.status} ${res.statusText}`;
        }
        return await res.text();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("abort")) {
          return "Error: visage server did not respond within 5 seconds";
        }
        return `Error: could not reach visage server — ${msg}`;
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

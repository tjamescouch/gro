/**
 * Visage plugin — registers avatar/persona tools with the plugin tool registry.
 *
 * `discover_avatar` calls the visage server to learn what the avatar body can do.
 * The raw manifest can be 100KB+, so we summarize it to ~2KB for the model.
 */

import { toolRegistry } from "../tool-registry.js";

interface Animation {
  name: string;
  duration: number;
  active: boolean;
}

interface Mesh {
  name: string;
  vertices: number;
  hasMorphTargets: boolean;
}

interface Capabilities {
  animations?: Animation[];
  bones?: string[];
  boneHierarchy?: Record<string, string>;
  morphTargets?: Record<string, string[]>;
  meshes?: Mesh[];
  activeClips?: string[];
}

/** Condense the raw capabilities manifest into a context-friendly summary. */
function summarizeCapabilities(raw: Capabilities): string {
  const lines: string[] = ["# Avatar Capabilities"];

  // Animations grouped by category
  const anims = raw.animations ?? [];
  const groups = new Map<string, { name: string; duration: number; active: boolean }[]>();
  for (const a of anims) {
    // Split on spaces; use first two words as category if 3+ words, else treat as standalone
    const parts = a.name.split(" ");
    const category = parts.length > 2 ? parts.slice(0, 2).join(" ") : "_standalone_";
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category)!.push(a);
  }

  lines.push(`\n## Animations (${anims.length} total)`);
  // Multi-item groups first
  for (const [category, items] of groups) {
    if (category === "_standalone_") continue;
    const names = items.map((i) => {
      const short = i.name.replace(category + " ", "");
      return i.active ? short : `~${short}~`;
    });
    lines.push(`- **${category}**: ${names.join(", ")}`);
  }
  // Standalone entries (single-word names, RIG.* controls) on one line
  const standalone = groups.get("_standalone_");
  if (standalone?.length) {
    const names = standalone.map((i) => (i.active ? i.name : `~${i.name}~`));
    lines.push(`- **RIG/other**: ${names.join(", ")}`);
  }
  lines.push("_(~strikethrough~ = inactive)_");

  // Active clips
  const active = raw.activeClips ?? [];
  if (active.length > 0) {
    lines.push(`\n## Active Clips (${active.length})`);
    lines.push(active.join(", "));
  }

  // Morph targets — just the target names per mesh
  const morphs = raw.morphTargets ?? {};
  const allTargets = new Set<string>();
  for (const targets of Object.values(morphs)) {
    for (const t of targets) allTargets.add(t);
  }
  if (allTargets.size > 0) {
    lines.push(`\n## Morph Targets (${allTargets.size} unique across ${Object.keys(morphs).length} meshes)`);
    lines.push([...allTargets].join(", "));
  }

  // Summary counts for the rest
  lines.push(`\n## Structure`);
  lines.push(`- Bones: ${raw.bones?.length ?? 0}`);
  lines.push(`- Meshes: ${raw.meshes?.length ?? 0}`);

  // Control instructions — teach the model how to animate
  lines.push(`\n## Control`);
  lines.push(`Embed avatar commands inline in your text using markers:`);
  lines.push("```");
  lines.push("@@[clip name:weight, clip name:weight]@@");
  lines.push("```");
  lines.push(`- Clip names match the animation names above (spaces ok)`);
  lines.push(`- Weight is 0.0–1.0 (default 1.0 if omitted)`);
  lines.push(`- Multiple clips can fire together for layered expressions`);

  // Build examples from actual active animations
  const activeAnims = (raw.animations ?? []).filter((a) => a.active);
  const faceAnim = activeAnims.find((a) => a.name.includes("face") && !a.name.includes("default"));
  const bodyAnim = activeAnims.find((a) => a.name.includes("full"));
  const mouthAnim = activeAnims.find((a) => a.name.includes("mouth") && a.name.includes("smile"));
  if (faceAnim && bodyAnim) {
    lines.push(`\nExample: \`@@[${faceAnim.name}:1.0,${bodyAnim.name}:0.8${mouthAnim ? `,${mouthAnim.name}:1.0` : ""}]@@\``);
  }

  return lines.join("\n");
}

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
          "Returns a summarized capabilities manifest describing available animations, " +
          "expressions, morph targets, and other controllable features.",
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
        const raw: Capabilities = await res.json();
        return summarizeCapabilities(raw);
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

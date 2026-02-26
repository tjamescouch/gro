/**
 * Visage plugin — registers avatar/persona tools with the plugin tool registry.
 *
 * `discover_avatar` calls the visage server to learn what the avatar body can do.
 * Returns a comprehensive markdown guide with all animations, blending rules,
 * and usage examples — the sole source of truth for avatar manipulation.
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

/** Condense the raw capabilities manifest into a comprehensive guide for avatar control. */
function summarizeCapabilities(raw: Capabilities): string {
  const lines: string[] = ["# Avatar Capabilities\n"];

  // ── Animations grouped by category ──
  const anims = raw.animations ?? [];
  const groups = new Map<string, Animation[]>();
  for (const a of anims) {
    const parts = a.name.split(" ");
    const category = parts.length > 2 ? parts.slice(0, 2).join(" ") : "_standalone_";
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category)!.push(a);
  }

  lines.push(`## Animations (${anims.length} total)\n`);
  lines.push("Use **full clip names** exactly as listed below.\n");
  lines.push("| Category | Clips |");
  lines.push("|----------|-------|");
  for (const [category, items] of groups) {
    if (category === "_standalone_") continue;
    const names = items.map((i) => {
      return i.active ? `\`${i.name}\`` : `~~\`${i.name}\`~~`;
    });
    lines.push(`| **${category}** | ${names.join(", ")} |`);
  }
  const standalone = groups.get("_standalone_");
  if (standalone?.length) {
    const names = standalone.map((i) =>
      i.active ? `\`${i.name}\`` : `~~\`${i.name}\`~~`
    );
    lines.push(`| **RIG/other** | ${names.join(", ")} |`);
  }
  lines.push("\n_(~~strikethrough~~ = currently inactive)_\n");

  // ── Active clips ──
  const active = raw.activeClips ?? [];
  if (active.length > 0) {
    lines.push(`## Currently Active Clips\n`);
    lines.push(active.map((c) => `\`${c}\``).join(", ") + "\n");
  }

  // ── Morph targets ──
  const morphs = raw.morphTargets ?? {};
  const allTargets = new Set<string>();
  for (const targets of Object.values(morphs)) {
    for (const t of targets) allTargets.add(t);
  }
  if (allTargets.size > 0) {
    lines.push(
      `## Morph Targets (${allTargets.size} unique across ${Object.keys(morphs).length} meshes)\n`
    );
    lines.push([...allTargets].join(", ") + "\n");
  }

  // ── Structure summary ──
  lines.push(`## Structure\n`);
  lines.push(`- Bones: ${raw.bones?.length ?? 0}`);
  lines.push(`- Meshes: ${raw.meshes?.length ?? 0}\n`);

  // ── How to Animate — comprehensive guide ──
  lines.push(`## How to Animate\n`);
  lines.push(`Embed avatar markers **inline in your text**. They are stripped before display (users see 🎭).\n`);
  lines.push("```");
  lines.push("@@[clip name:weight, clip name:weight]@@");
  lines.push("```\n");
  lines.push(`- **Weights**: 0.0–1.0 (default 1.0 if omitted)`);
  lines.push(`- **Clip names**: Use the exact full names from the table above`);
  lines.push(
    `- **Multiple clips** can fire in one marker for layered expressions\n`
  );

  lines.push(`### Blending Rules\n`);
  lines.push(
    `- **Face/eye/mouth/hand/rig clips** blend together simultaneously — combine for rich expressions`
  );
  lines.push(
    `- **Full body clips** crossfade exclusively — only one plays at a time, transitions are automatic`
  );
  lines.push(
    `- **Idle** always runs in background. Omit markers for neutral rest state.\n`
  );

  lines.push(`### Pacing\n`);
  lines.push(
    `- Place **one marker per sentence or clause** — matches natural speaking cadence`
  );
  lines.push(
    `- Position at **emotional beats**, not bunched at start or end of response`
  );
  lines.push(
    `- **Don't over-animate** — use markers at peaks and transitions, not every sentence`
  );
  lines.push(
    `- Vary your gestures — don't repeat the same expression consecutively\n`
  );

  // ── Dynamic examples built from actual animations ──
  const activeAnims = anims.filter((a) => a.active);
  const faceAnims = activeAnims.filter(
    (a) => a.name.includes("face") && !a.name.includes("default")
  );
  const eyeAnims = activeAnims.filter(
    (a) => a.name.includes("eyemask") || a.name.includes("eymask")
  );
  const mouthAnims = activeAnims.filter((a) =>
    /mouth|Mouth/i.test(a.name)
  );
  const bodyAnims = activeAnims.filter((a) => a.name.includes("full"));

  lines.push(`### Examples\n`);
  lines.push("Weave markers naturally into speech:\n");
  lines.push("```");

  // Build 3 diverse examples from actual available animations
  if (faceAnims.length > 0 && eyeAnims.length > 0) {
    const face = faceAnims[0];
    const eye = eyeAnims.find((e) => e.name.includes("content")) || eyeAnims[0];
    lines.push(
      `@@[${face.name}:0.8, ${eye.name}:0.7]@@ That's a really interesting idea!`
    );
  }
  if (faceAnims.length > 1) {
    const face = faceAnims.find((f) => f.name.includes("squint")) || faceAnims[1];
    lines.push(
      `I think we could @@[${face.name}:0.6]@@ approach this differently.`
    );
  }
  if (bodyAnims.length > 0 && mouthAnims.length > 0) {
    const body = bodyAnims.find((b) => b.name.includes("cheerful")) || bodyAnims[0];
    const mouth =
      mouthAnims.find((m) => m.name.includes("smile")) || mouthAnims[0];
    lines.push(
      `@@[${body.name}:1.0, ${mouth.name}:0.9]@@ Let's do it!`
    );
  }
  if (bodyAnims.length > 1) {
    const body = bodyAnims.find((b) => b.name.includes("waving")) || bodyAnims[bodyAnims.length - 1];
    lines.push(`@@[${body.name}:1.0]@@ See you later!`);
  }

  lines.push("```");

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
          "Returns a comprehensive guide with all available animations, " +
          "morph targets, blending rules, and usage examples. " +
          "Call this on your first turn to learn how to animate your avatar.",
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

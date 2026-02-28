/**
 * SensoryViewFactory — class factory for creating sensory channel views.
 *
 * Centralizes channel configuration (ViewSpec) alongside the factory function
 * that creates each view's SensorySource. The factory is instance-based so
 * tests can create isolated registries.
 *
 * Usage:
 *   const factory = createDefaultFactory();
 *   for (const spec of factory.specs()) {
 *     sensory.addChannel({ ...spec, content: "", source: factory.create(spec.name, deps) });
 *   }
 */

import type { SensorySource } from "./sensory-memory.js";
import type { AgentMemory } from "./agent-memory.js";
import { ContextMapSource } from "./context-map-source.js";
import { TemporalSource } from "./temporal-source.js";
import { ConfigSource } from "./config-source.js";
import { SelfSource } from "./self-source.js";
import { TaskSource } from "./task-source.js";
import { SocialSource } from "./social-source.js";
import { SpendSource } from "./spend-source.js";
import { ViolationsSource } from "./violations-source.js";
import { AwarenessSource } from "./awareness-source.js";

/** Channel configuration — lives alongside the view that renders it. */
export interface ViewSpec {
  name: string;
  maxTokens: number;
  width: number;
  height: number;
  enabled: boolean;
  updateMode: "every_turn" | "manual";
  /** Whether this view can be assigned to camera slots. false = canvas-only (e.g. 'self'). */
  viewable: boolean;
}

/** Dependencies available to view factory functions. */
export interface ViewDeps {
  memory: AgentMemory;
  spendMeter?: any;
  [key: string]: any;
}

type ViewCreator = (deps: ViewDeps) => SensorySource;

interface ViewEntry {
  spec: ViewSpec;
  create: ViewCreator;
}

export class SensoryViewFactory {
  private entries = new Map<string, ViewEntry>();

  /** Register a view spec with its factory function. */
  register(spec: ViewSpec, create: ViewCreator): void {
    this.entries.set(spec.name, { spec, create });
  }

  /** Create a view source by name. */
  create(name: string, deps: ViewDeps): SensorySource {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Unknown sensory view: ${name}`);
    return entry.create(deps);
  }

  /** Get the spec for a named view. */
  getSpec(name: string): ViewSpec | undefined {
    return this.entries.get(name)?.spec;
  }

  /** All registered view names in registration order. */
  names(): string[] {
    return Array.from(this.entries.keys());
  }

  /** All specs in registration order. */
  specs(): ViewSpec[] {
    return Array.from(this.entries.values()).map(e => e.spec);
  }

  /** Names of views that cannot be assigned to camera slots. */
  nonViewableNames(): string[] {
    return Array.from(this.entries.values())
      .filter(e => !e.spec.viewable)
      .map(e => e.spec.name);
  }
}

/** Create the default factory with all built-in sensory views registered. */
export function createDefaultFactory(): SensoryViewFactory {
  const factory = new SensoryViewFactory();

  factory.register(
    { name: "context", maxTokens: 800, width: 82, height: 40, enabled: true, updateMode: "every_turn", viewable: true },
    (deps) => new ContextMapSource(deps.memory, { maxChars: Math.floor(800 * 2.8), maxLines: 40 }),
  );

  factory.register(
    { name: "time", maxTokens: 200, width: 82, height: 22, enabled: true, updateMode: "every_turn", viewable: true },
    () => new TemporalSource(),
  );

  factory.register(
    { name: "tasks", maxTokens: 150, width: 82, height: 12, enabled: false, updateMode: "every_turn", viewable: true },
    () => new TaskSource(),
  );

  factory.register(
    { name: "social", maxTokens: 200, width: 82, height: 12, enabled: true, updateMode: "every_turn", viewable: true },
    () => new SocialSource(),
  );

  factory.register(
    { name: "spend", maxTokens: 100, width: 82, height: 12, enabled: false, updateMode: "every_turn", viewable: true },
    (deps) => new SpendSource(deps.spendMeter),
  );

  factory.register(
    { name: "violations", maxTokens: 80, width: 82, height: 12, enabled: false, updateMode: "every_turn", viewable: true },
    () => new ViolationsSource(null),
  );

  factory.register(
    { name: "awareness", maxTokens: 120, width: 82, height: 10, enabled: true, updateMode: "every_turn", viewable: true },
    () => new AwarenessSource(),
  );

  factory.register(
    { name: "config", maxTokens: 120, width: 82, height: 17, enabled: true, updateMode: "every_turn", viewable: true },
    () => new ConfigSource(),
  );

  factory.register(
    { name: "self", maxTokens: 200, width: 82, height: 20, enabled: false, updateMode: "every_turn", viewable: true },
    () => new SelfSource(),
  );

  return factory;
}

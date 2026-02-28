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
import { ContextMapSource } from "./context-map-source.js";
import { TemporalSource } from "./temporal-source.js";
import { ConfigSource } from "./config-source.js";
import { SelfSource } from "./self-source.js";
import { TaskSource } from "./task-source.js";
import { SocialSource } from "./social-source.js";
import { SpendSource } from "./spend-source.js";
import { ViolationsSource } from "./violations-source.js";
export class SensoryViewFactory {
    constructor() {
        this.entries = new Map();
    }
    /** Register a view spec with its factory function. */
    register(spec, create) {
        this.entries.set(spec.name, { spec, create });
    }
    /** Create a view source by name. */
    create(name, deps) {
        const entry = this.entries.get(name);
        if (!entry)
            throw new Error(`Unknown sensory view: ${name}`);
        return entry.create(deps);
    }
    /** Get the spec for a named view. */
    getSpec(name) {
        return this.entries.get(name)?.spec;
    }
    /** All registered view names in registration order. */
    names() {
        return Array.from(this.entries.keys());
    }
    /** All specs in registration order. */
    specs() {
        return Array.from(this.entries.values()).map(e => e.spec);
    }
    /** Names of views that cannot be assigned to camera slots. */
    nonViewableNames() {
        return Array.from(this.entries.values())
            .filter(e => !e.spec.viewable)
            .map(e => e.spec.name);
    }
}
/** Create the default factory with all built-in sensory views registered. */
export function createDefaultFactory() {
    const factory = new SensoryViewFactory();
    factory.register({ name: "context", maxTokens: 800, width: 80, height: 40, enabled: true, updateMode: "every_turn", viewable: true }, (deps) => new ContextMapSource(deps.memory, { maxChars: Math.floor(800 * 2.8), maxLines: 40 }));
    factory.register({ name: "time", maxTokens: 200, width: 80, height: 22, enabled: true, updateMode: "every_turn", viewable: true }, () => new TemporalSource());
    factory.register({ name: "tasks", maxTokens: 150, width: 48, height: 12, enabled: false, updateMode: "every_turn", viewable: true }, () => new TaskSource());
    factory.register({ name: "social", maxTokens: 200, width: 48, height: 12, enabled: true, updateMode: "every_turn", viewable: true }, () => new SocialSource());
    factory.register({ name: "spend", maxTokens: 100, width: 48, height: 12, enabled: false, updateMode: "every_turn", viewable: true }, (deps) => new SpendSource(deps.spendMeter));
    factory.register({ name: "violations", maxTokens: 80, width: 48, height: 12, enabled: false, updateMode: "every_turn", viewable: true }, () => new ViolationsSource(null));
    factory.register({ name: "config", maxTokens: 120, width: 80, height: 17, enabled: true, updateMode: "every_turn", viewable: true }, () => new ConfigSource());
    factory.register({ name: "self", maxTokens: 200, width: 80, height: 20, enabled: false, updateMode: "every_turn", viewable: false }, () => new SelfSource());
    return factory;
}

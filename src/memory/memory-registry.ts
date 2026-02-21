import type { AgentMemory } from "./agent-memory.js";
import type { ChatDriver } from "../drivers/types.js";

/**
 * Memory type factory signature.
 * Receives config object that may include systemPrompt, driver, model, etc.
 */
export type MemoryFactory = (config: MemoryFactoryConfig) => AgentMemory | Promise<AgentMemory>;

export interface MemoryFactoryConfig {
  systemPrompt?: string;
  driver?: ChatDriver;
  model?: string;
  provider?: string;
  [key: string]: unknown;
}

export interface MemoryTypeDescriptor {
  /** Unique type identifier */
  type: string;
  /** Human-readable label */
  label: string;
  /** Short description of behavior/tradeoffs */
  description: string;
  /** Factory function to instantiate this memory type */
  factory: MemoryFactory;
  /** Default configuration values */
  defaults?: Record<string, unknown>;
  /** Parameter schema (optional, for runtime inspection) */
  parameters?: MemoryParameter[];
}

export interface MemoryParameter {
  name: string;
  type: "string" | "number" | "boolean" | "enum";
  description: string;
  defaultValue?: unknown;
  range?: { min?: number; max?: number };
  options?: string[];
  required?: boolean;
}

/**
 * Global registry for memory implementations.
 * Memory types register themselves on module load.
 */
class MemoryRegistry {
  private types = new Map<string, MemoryTypeDescriptor>();

  register(descriptor: MemoryTypeDescriptor): void {
    if (this.types.has(descriptor.type)) {
      throw new Error(`Memory type '${descriptor.type}' is already registered.`);
    }
    this.types.set(descriptor.type, descriptor);
  }

  get(type: string): MemoryTypeDescriptor | undefined {
    return this.types.get(type);
  }

  list(): MemoryTypeDescriptor[] {
    return Array.from(this.types.values());
  }

  has(type: string): boolean {
    return this.types.has(type);
  }

  async create(type: string, config: MemoryFactoryConfig): Promise<AgentMemory> {
    const descriptor = this.types.get(type);
    if (!descriptor) {
      throw new Error(`Memory type '${type}' not found. Available: ${Array.from(this.types.keys()).join(", ")}`);
    }

    // Merge defaults with provided config
    const mergedConfig = { ...descriptor.defaults, ...config };
    return await descriptor.factory(mergedConfig);
  }
}

export const memoryRegistry = new MemoryRegistry();

/**
 * Global registry for memory implementations.
 * Memory types register themselves on module load.
 */
class MemoryRegistry {
    constructor() {
        this.types = new Map();
    }
    register(descriptor) {
        if (this.types.has(descriptor.type)) {
            throw new Error(`Memory type '${descriptor.type}' is already registered.`);
        }
        this.types.set(descriptor.type, descriptor);
    }
    get(type) {
        return this.types.get(type);
    }
    list() {
        return Array.from(this.types.values());
    }
    has(type) {
        return this.types.has(type);
    }
    async create(type, config) {
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

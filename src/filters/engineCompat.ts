import type { EngineCapabilities } from '../ipc';

/** Engine features visual metadata filters depend on. */
export const REQUIRED_FILTER_CAPABILITIES = ['structuredFiltersV1', 'metadataOnlyPagination'];

interface CapabilityClient {
  getCapabilities?: (timeoutMs?: number) => Promise<EngineCapabilities>;
}

export function missingCapabilities(
  caps: EngineCapabilities,
  required: readonly string[],
): string[] {
  return required.filter((name) => !caps.capabilities.includes(name));
}

export function incompatibleEngineMessage(
  caps: EngineCapabilities,
  missing: readonly string[],
): string {
  if (caps.propertyIndexError) {
    return `Metadata filters are unavailable: ${caps.propertyIndexError}`;
  }
  return (
    `The search engine does not support metadata filters (missing: ${missing.join(', ')}). ` +
    'Update Search Plus Engine and restart the search server. ' +
    'Results are not shown because they would ignore your filters.'
  );
}

/**
 * Capability report per client instance, fetched once and reused. A new client (after
 * a settings change or restart) gets a fresh check; a failed check is retried next time.
 */
export class EngineCapabilityCache {
  private cache = new WeakMap<object, Promise<EngineCapabilities>>();

  get(client: object & CapabilityClient): Promise<EngineCapabilities> {
    const cached = this.cache.get(client);
    if (cached) return cached;
    if (typeof client.getCapabilities !== 'function') {
      return Promise.resolve({ apiVersion: 1, capabilities: [] });
    }
    const pending = client.getCapabilities().catch((error: unknown) => {
      this.cache.delete(client);
      throw error;
    });
    this.cache.set(client, pending);
    return pending;
  }

  reset(client?: object): void {
    if (client) this.cache.delete(client);
    else this.cache = new WeakMap();
  }
}

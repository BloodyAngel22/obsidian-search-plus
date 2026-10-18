import type { EngineCapabilityCache } from './engineCompat';
import type { FilterStore } from './filterStore';
import type { MetadataCatalog } from './metadataCatalog';
import type { MetadataMenuAdapter } from './metadataMenu';

/** Everything the search views need for metadata filtering, owned by the plugin. */
export interface FilterServices {
  store: FilterStore;
  catalog: MetadataCatalog;
  metadataMenu: MetadataMenuAdapter;
  capabilities: EngineCapabilityCache;
}

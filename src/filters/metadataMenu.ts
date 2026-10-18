import { TFile, type App } from 'obsidian';

/**
 * Optional UI hints from the Metadata Menu plugin.
 *
 * Only the plugin's public `api` object is used (`namedFileFields` / `fileFields`),
 * never its settings or internal state. Hints only change which editor and which
 * suggestions are offered — Metadata Menu never decides which notes match; the
 * engine matches the YAML values it indexed.
 *
 * Metadata Menu reports fields from YAML and inline sources together, and its
 * `sourceType` says where the field DEFINITION comes from, not where the value is
 * stored. So a hint is only ever requested for a property the catalog already saw in
 * YAML (via MetadataCache); inline-only fields can never enter the filter catalog.
 */

type MetadataMenuEditor = 'select' | 'multi' | 'boolean' | 'generic';

export interface MetadataMenuHint {
  editor: MetadataMenuEditor;
  /** Option values defined in Metadata Menu; extra suggestions, never a whitelist. */
  options: string[];
  /** Why there is no specific editor (absent plugin, conflict, error...). */
  reason?: 'unavailable' | 'conflict' | 'error' | 'unknown-type' | 'no-definition';
}

const GENERIC = (reason: MetadataMenuHint['reason']): MetadataMenuHint => ({
  editor: 'generic',
  options: [],
  reason,
});

interface FieldInfoLike {
  type?: unknown;
  options?: unknown;
}

type FieldsResult = Record<string, FieldInfoLike>;

interface MetadataMenuApi {
  namedFileFields?: (file: TFile | string) => Promise<FieldsResult> | FieldsResult;
  fileFields?: (file: TFile | string) => Promise<FieldsResult> | FieldsResult;
}

interface PluginRegistryLike {
  enabledPlugins?: Set<string>;
  getPlugin?: (id: string) => { api?: unknown } | null | undefined;
  plugins?: Record<string, { api?: unknown } | undefined>;
}

const PLUGIN_ID = 'metadata-menu';
const CALL_TIMEOUT_MS = 1500;

function editorForType(type: unknown): MetadataMenuEditor | null {
  if (typeof type !== 'string') return null;
  switch (type.toLowerCase()) {
    case 'select':
    case 'cycle':
      return 'select';
    case 'multi':
    case 'multiselect':
      return 'multi';
    case 'boolean':
      return 'boolean';
    default:
      return null;
  }
}

/** Option values from a field definition, accepting the shapes the API is known to use. */
function optionsFrom(options: unknown): string[] {
  if (typeof options !== 'object' || options === null) return [];
  const list: unknown = (options as { valuesList?: unknown }).valuesList ?? options;
  let values: unknown[] = [];
  if (Array.isArray(list)) values = list;
  else if (typeof list === 'object' && list !== null) values = Object.values(list);
  return values.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Metadata Menu API timed out')), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export class MetadataMenuAdapter {
  private cache = new Map<string, Promise<MetadataMenuHint>>();

  constructor(private readonly app: App) {}

  /** The public API object, or null when the plugin is absent, disabled or too old. */
  private getApi(): MetadataMenuApi | null {
    try {
      const registry = (this.app as unknown as { plugins?: PluginRegistryLike }).plugins;
      if (!registry) return null;
      if (registry.enabledPlugins && !registry.enabledPlugins.has(PLUGIN_ID)) return null;
      const plugin = registry.getPlugin?.(PLUGIN_ID) ?? registry.plugins?.[PLUGIN_ID];
      const api = plugin?.api as MetadataMenuApi | undefined;
      if (!api || typeof api !== 'object') return null;
      if (typeof api.namedFileFields !== 'function' && typeof api.fileFields !== 'function') {
        return null;
      }
      return api;
    } catch {
      return null;
    }
  }

  isAvailable(): boolean {
    return this.getApi() !== null;
  }

  /** Forget cached hints (e.g. after notes or the plugin changed). */
  invalidate(): void {
    this.cache.clear();
  }

  /**
   * Hint for a YAML property, from the effective field settings of up to a few notes
   * that have it. Agreement is required: if notes disagree (different FileClasses,
   * overrides), the generic editor is used instead of guessing.
   */
  getHint(field: string, samplePaths: readonly string[]): Promise<MetadataMenuHint> {
    const cached = this.cache.get(field);
    if (cached) return cached;
    const pending = this.computeHint(field, samplePaths).catch(() => GENERIC('error'));
    this.cache.set(field, pending);
    return pending;
  }

  private async computeHint(
    field: string,
    samplePaths: readonly string[],
  ): Promise<MetadataMenuHint> {
    const api = this.getApi();
    if (!api) return GENERIC('unavailable');
    const editors = new Set<MetadataMenuEditor | 'unknown'>();
    const options = new Set<string>();
    let found = false;
    let failed = false;
    for (const path of samplePaths) {
      const fields = await this.readFields(api, path);
      if (fields === 'error') {
        failed = true;
        continue;
      }
      if (!fields) continue;
      const info = fields[field];
      if (!info) continue;
      found = true;
      editors.add(editorForType(info.type) ?? 'unknown');
      for (const option of optionsFrom(info.options)) options.add(option);
    }
    if (!found) return GENERIC(failed ? 'error' : 'no-definition');
    if (editors.size > 1) return GENERIC('conflict');
    const [editor] = [...editors];
    if (!editor || editor === 'unknown') return GENERIC('unknown-type');
    return { editor, options: [...options] };
  }

  private async readFields(
    api: MetadataMenuApi,
    path: string,
  ): Promise<FieldsResult | null | 'error'> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    const call = api.namedFileFields ?? api.fileFields;
    try {
      const result = await withTimeout(Promise.resolve(call!.call(api, file)), CALL_TIMEOUT_MS);
      if (!result || typeof result !== 'object') return null;
      if (api.namedFileFields) return result;
      // fileFields is keyed by field id; re-key by the field's name when present.
      const byName: FieldsResult = {};
      for (const info of Object.values(result)) {
        const name = (info as { name?: unknown }).name;
        if (typeof name === 'string') byName[name] = info;
      }
      return byName;
    } catch {
      return 'error';
    }
  }
}

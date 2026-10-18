import { TFile, type App, type CachedMetadata, type EventRef, type TAbstractFile } from 'obsidian';
import { isFilterScalar, scalarKey } from './filterState';
import type { FilterScalar } from './types';

/** How a property's value looked in one note. `list` = YAML sequence. */
type ObservedShape = 'string' | 'number' | 'boolean' | 'null' | 'list' | 'object';

export interface PropertyValueInfo {
  value: FilterScalar;
  /** Notes containing this value (each note counted once). */
  count: number;
}

export interface PropertyInfo {
  /** Original YAML key spelling. Keys differing only in case stay separate. */
  name: string;
  noteCount: number;
  /** Shapes observed across notes, with note counts. */
  shapes: ReadonlyMap<ObservedShape, number>;
  /** Scalar types observed in values (including list elements). */
  valueTypes: ReadonlySet<'string' | 'number' | 'boolean' | 'null'>;
  distinctValues: number;
  /** Other keys equal to this one ignoring case, e.g. `Status` for `status`. */
  caseVariants: string[];
}

export type CatalogState = 'idle' | 'scanning' | 'ready';

interface FileContribution {
  /** field → shape and the note's distinct values (by scalarKey). */
  fields: Map<string, { shape: ObservedShape; values: Map<string, FilterScalar> }>;
}

interface PropertyAggregate {
  name: string;
  noteCount: number;
  shapes: Map<ObservedShape, number>;
  values: Map<string, PropertyValueInfo>;
}

interface CatalogEnv {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const defaultEnv: CatalogEnv = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

/** Obsidian before 1.4 put the frontmatter position inside the frontmatter object. */
function isLegacyPositionEntry(key: string, value: unknown): boolean {
  if (key !== 'position' || typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.start === 'object' && typeof v.end === 'object';
}

function shapeOf(value: unknown): ObservedShape {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'object';
}

/** Read a note's YAML properties from MetadataCache into one contribution. Inline
 *  (Dataview-style `key:: value`) fields are not part of `frontmatter` and are ignored. */
export function contributionFromCache(cache: CachedMetadata | null | undefined): FileContribution {
  const fields: FileContribution['fields'] = new Map();
  const frontmatter: Record<string, unknown> | undefined = cache?.frontmatter;
  if (!frontmatter || typeof frontmatter !== 'object') return { fields };
  for (const [key, raw] of Object.entries(frontmatter)) {
    if (!key || isLegacyPositionEntry(key, raw)) continue;
    const shape = shapeOf(raw);
    const values = new Map<string, FilterScalar>();
    const items = Array.isArray(raw) ? (raw as unknown[]) : [raw ?? null];
    for (const item of items) {
      const value = item === undefined ? null : item;
      if (!isFilterScalar(value)) continue;
      values.set(scalarKey(value), value);
    }
    fields.set(key, { shape, values });
  }
  return { fields };
}

/**
 * Catalog of YAML property names and values in the vault, built from Obsidian's
 * MetadataCache (the authority for what the user sees as Properties).
 *
 * The initial scan runs in small batches on timers so it never blocks the UI. After
 * that, each file event replaces just that file's contribution: the old contribution
 * is subtracted before the new one is added, so counts stay exact without rescans.
 * Values are suggestions only — the engine decides what matches.
 */
export class MetadataCatalog {
  private contributions = new Map<string, FileContribution>();
  private aggregates = new Map<string, PropertyAggregate>();
  private listeners = new Set<() => void>();
  private eventRefs: Array<{ off: () => void }> = [];
  private notifyTimer: number | undefined;
  private scanTimer: number | undefined;
  private state: CatalogState = 'idle';
  private scanned = 0;
  private scanTotal = 0;

  constructor(
    private readonly app: App,
    private readonly env: CatalogEnv = defaultEnv,
    private readonly batchSize = 250,
    private readonly notifyDelayMs = 200,
  ) {}

  /** Subscribe to vault events and start the background scan. Idempotent. */
  start(): void {
    if (this.state !== 'idle') return;
    this.registerEvents();
    this.state = 'scanning';
    const vault = this.app.vault as Partial<App['vault']> | undefined;
    const files = typeof vault?.getMarkdownFiles === 'function' ? vault.getMarkdownFiles() : [];
    this.scanTotal = files.length;
    this.scanned = 0;
    const step = (index: number) => {
      const end = Math.min(index + this.batchSize, files.length);
      for (let i = index; i < end; i++) {
        const file = files[i]!;
        // A file may already be known from a live event during the scan.
        if (!this.contributions.has(file.path)) this.updateFile(file, false);
      }
      this.scanned = end;
      if (end < files.length) {
        this.scanTimer = this.env.setTimeout(() => step(end), 0);
      } else {
        this.scanTimer = undefined;
        this.state = 'ready';
        this.scheduleNotify(0);
      }
    };
    this.scanTimer = this.env.setTimeout(() => step(0), 0);
  }

  stop(): void {
    if (this.scanTimer !== undefined) this.env.clearTimeout(this.scanTimer);
    if (this.notifyTimer !== undefined) this.env.clearTimeout(this.notifyTimer);
    this.scanTimer = undefined;
    this.notifyTimer = undefined;
    for (const ref of this.eventRefs) ref.off();
    this.eventRefs = [];
    this.listeners.clear();
    this.state = 'idle';
  }

  getState(): { state: CatalogState; scanned: number; total: number } {
    return { state: this.state, scanned: this.scanned, total: this.scanTotal };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Replace one file's contribution with what MetadataCache currently holds. */
  updateFile(file: TFile, notify = true): void {
    if (file.extension !== 'md') return;
    const cache = this.app.metadataCache?.getFileCache?.(file) ?? null;
    this.applyContribution(file.path, contributionFromCache(cache));
    if (notify) this.scheduleNotify();
  }

  removeFile(path: string): void {
    if (!this.contributions.has(path)) return;
    this.applyContribution(path, null);
    this.scheduleNotify();
  }

  renameFile(file: TFile, oldPath: string): void {
    const previous = this.contributions.get(oldPath);
    if (previous) {
      this.contributions.delete(oldPath);
      this.contributions.set(file.path, previous);
    }
    // The cache entry may be refreshed after a rename; re-read to stay exact.
    this.updateFile(file);
  }

  getProperties(): PropertyInfo[] {
    const lowerIndex = new Map<string, string[]>();
    for (const name of this.aggregates.keys()) {
      const lower = name.toLowerCase();
      lowerIndex.set(lower, [...(lowerIndex.get(lower) ?? []), name]);
    }
    return [...this.aggregates.values()]
      .map((agg) => this.toInfo(agg, lowerIndex))
      .sort((a, b) => b.noteCount - a.noteCount || a.name.localeCompare(b.name));
  }

  getProperty(name: string): PropertyInfo | undefined {
    const agg = this.aggregates.get(name);
    if (!agg) return undefined;
    const variants = [...this.aggregates.keys()].filter(
      (other) => other !== name && other.toLowerCase() === name.toLowerCase(),
    );
    return { ...this.toInfo(agg, new Map()), caseVariants: variants };
  }

  /** Property names matching `query` (case-insensitive substring), most used first. */
  searchProperties(query: string, limit: number): PropertyInfo[] {
    const needle = query.trim().toLowerCase();
    const all = this.getProperties();
    const matches = needle ? all.filter((p) => p.name.toLowerCase().includes(needle)) : all;
    if (needle) {
      matches.sort((a, b) => {
        const ap = a.name.toLowerCase().startsWith(needle) ? 0 : 1;
        const bp = b.name.toLowerCase().startsWith(needle) ? 0 : 1;
        return ap - bp || b.noteCount - a.noteCount || a.name.localeCompare(b.name);
      });
    }
    return matches.slice(0, limit);
  }

  /** Values of `field` matching `query`, most common first. Bounded by `limit`. */
  searchValues(
    field: string,
    query: string,
    limit: number,
  ): { values: PropertyValueInfo[]; total: number } {
    const agg = this.aggregates.get(field);
    if (!agg) return { values: [], total: 0 };
    const needle = query.trim().toLowerCase();
    const matches: PropertyValueInfo[] = [];
    for (const info of agg.values.values()) {
      if (
        needle &&
        !String(info.value ?? '')
          .toLowerCase()
          .includes(needle)
      )
        continue;
      matches.push(info);
    }
    matches.sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
    return { values: matches.slice(0, limit), total: matches.length };
  }

  /** Note count for a typed value of `field` (0 when it occurs nowhere). */
  valueCount(field: string, value: FilterScalar): number {
    return this.aggregates.get(field)?.values.get(scalarKey(value))?.count ?? 0;
  }

  /** Markdown paths whose YAML contains `field` (for optional enrichment sampling). */
  samplePathsWithField(field: string, limit: number): string[] {
    const paths: string[] = [];
    for (const [path, contribution] of this.contributions) {
      if (contribution.fields.has(field)) paths.push(path);
      if (paths.length >= limit) break;
    }
    return paths;
  }

  private toInfo(agg: PropertyAggregate, lowerIndex: Map<string, string[]>): PropertyInfo {
    const valueTypes = new Set<'string' | 'number' | 'boolean' | 'null'>();
    for (const info of agg.values.values()) {
      valueTypes.add(
        info.value === null ? 'null' : (typeof info.value as 'string' | 'number' | 'boolean'),
      );
    }
    return {
      name: agg.name,
      noteCount: agg.noteCount,
      shapes: agg.shapes,
      valueTypes,
      distinctValues: agg.values.size,
      caseVariants: (lowerIndex.get(agg.name.toLowerCase()) ?? []).filter((n) => n !== agg.name),
    };
  }

  private applyContribution(path: string, next: FileContribution | null): void {
    const previous = this.contributions.get(path);
    if (previous) this.subtract(previous);
    if (next && next.fields.size > 0) {
      this.contributions.set(path, next);
      this.add(next);
    } else if (next) {
      // Keep an empty marker so the scan does not re-read it.
      this.contributions.set(path, next);
    } else {
      this.contributions.delete(path);
    }
  }

  private add(contribution: FileContribution): void {
    for (const [field, { shape, values }] of contribution.fields) {
      let agg = this.aggregates.get(field);
      if (!agg) {
        agg = { name: field, noteCount: 0, shapes: new Map(), values: new Map() };
        this.aggregates.set(field, agg);
      }
      agg.noteCount += 1;
      agg.shapes.set(shape, (agg.shapes.get(shape) ?? 0) + 1);
      for (const [key, value] of values) {
        const info = agg.values.get(key);
        if (info) info.count += 1;
        else agg.values.set(key, { value, count: 1 });
      }
    }
  }

  private subtract(contribution: FileContribution): void {
    for (const [field, { shape, values }] of contribution.fields) {
      const agg = this.aggregates.get(field);
      if (!agg) continue;
      agg.noteCount -= 1;
      const shapeCount = (agg.shapes.get(shape) ?? 1) - 1;
      if (shapeCount <= 0) agg.shapes.delete(shape);
      else agg.shapes.set(shape, shapeCount);
      for (const key of values.keys()) {
        const info = agg.values.get(key);
        if (!info) continue;
        info.count -= 1;
        if (info.count <= 0) agg.values.delete(key);
      }
      if (agg.noteCount <= 0) this.aggregates.delete(field);
    }
  }

  private scheduleNotify(delay = this.notifyDelayMs): void {
    if (this.notifyTimer !== undefined) this.env.clearTimeout(this.notifyTimer);
    this.notifyTimer = this.env.setTimeout(() => {
      this.notifyTimer = undefined;
      for (const listener of [...this.listeners]) {
        try {
          listener();
        } catch (error) {
          console.error('Search Plus: catalog listener failed.', error);
        }
      }
    }, delay);
  }

  private registerEvents(): void {
    const { metadataCache, vault } = this.app as Partial<Pick<App, 'metadataCache' | 'vault'>>;
    const track = (source: { offref?(ref: EventRef): void }, ref: EventRef) => {
      this.eventRefs.push({ off: () => source.offref?.(ref) });
    };
    if (metadataCache && typeof metadataCache.on === 'function') {
      // 'changed' covers create, modify and external edits once the cache is parsed.
      track(
        metadataCache,
        metadataCache.on('changed', (file: TFile) => this.updateFile(file)),
      );
      track(
        metadataCache,
        metadataCache.on('deleted', (file: TFile) => this.removeFile(file.path)),
      );
    }
    if (vault && typeof vault.on === 'function') {
      track(
        vault,
        vault.on('delete', (file: TAbstractFile) => this.removeFile(file.path)),
      );
      track(
        vault,
        vault.on('rename', (file: TAbstractFile, oldPath: string) => {
          if (file instanceof TFile && file.extension === 'md') this.renameFile(file, oldPath);
          else this.removeFile(oldPath);
        }),
      );
    }
  }
}

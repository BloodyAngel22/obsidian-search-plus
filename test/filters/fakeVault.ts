import type { App } from 'obsidian';
import { TFile } from 'obsidian';

type Handler = (...args: unknown[]) => void;

class Emitter {
  private handlers = new Map<string, Set<Handler>>();
  on(name: string, handler: Handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name)!.add(handler);
    return { name, handler };
  }
  offref(ref: { name: string; handler: Handler }) {
    this.handlers.get(ref.name)?.delete(ref.handler);
  }
  trigger(name: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(name) ?? []) handler(...args);
  }
  count(name: string): number {
    return this.handlers.get(name)?.size ?? 0;
  }
}

/** In-memory vault + MetadataCache with the events the catalog listens to. */
export class FakeVault {
  readonly frontmatter = new Map<string, Record<string, unknown> | undefined>();
  readonly vaultEvents = new Emitter();
  readonly cacheEvents = new Emitter();
  plugins: unknown = undefined;

  file(path: string): TFile {
    return Object.assign(new TFile(), { path, extension: path.split('.').pop() ?? '' });
  }

  set(path: string, fm: Record<string, unknown> | undefined): TFile {
    this.frontmatter.set(path, fm);
    return this.file(path);
  }

  /** Simulates an edit: MetadataCache re-parses and fires 'changed'. */
  edit(path: string, fm: Record<string, unknown> | undefined): void {
    this.cacheEvents.trigger('changed', this.set(path, fm));
  }

  remove(path: string): void {
    const file = this.file(path);
    this.frontmatter.delete(path);
    this.vaultEvents.trigger('delete', file);
    this.cacheEvents.trigger('deleted', file);
  }

  rename(oldPath: string, newPath: string): void {
    const fm = this.frontmatter.get(oldPath);
    this.frontmatter.delete(oldPath);
    this.frontmatter.set(newPath, fm);
    this.vaultEvents.trigger('rename', this.file(newPath), oldPath);
  }

  app(): App {
    const vault = {
      getMarkdownFiles: () =>
        [...this.frontmatter.keys()].filter((p) => p.endsWith('.md')).map((p) => this.file(p)),
      getAbstractFileByPath: (p: string) => (this.frontmatter.has(p) ? this.file(p) : null),
      on: (name: string, h: Handler) => this.vaultEvents.on(name, h),
      offref: (ref: { name: string; handler: Handler }) => this.vaultEvents.offref(ref),
    };
    const metadataCache = {
      getFileCache: (file: TFile) => {
        const fm = this.frontmatter.get(file.path);
        return fm === undefined ? {} : { frontmatter: fm };
      },
      on: (name: string, h: Handler) => this.cacheEvents.on(name, h),
      offref: (ref: { name: string; handler: Handler }) => this.cacheEvents.offref(ref),
    };
    return { vault, metadataCache, plugins: this.plugins } as unknown as App;
  }
}

/** Synchronous timer env: run all queued timers on demand. */
export class ManualTimers {
  private queue = new Map<number, () => void>();
  private next = 1;
  setTimeout = (fn: () => void): number => {
    const id = this.next++;
    this.queue.set(id, fn);
    return id;
  };
  clearTimeout = (id: number): void => {
    this.queue.delete(id);
  };
  pending(): number {
    return this.queue.size;
  }
  /** Runs one round of queued timers (timers queued while running wait for the next round). */
  tick(): void {
    const batch = [...this.queue.entries()];
    this.queue.clear();
    for (const [, fn] of batch) fn();
  }
  runAll(limit = 1000): void {
    for (let i = 0; i < limit && this.queue.size > 0; i++) this.tick();
  }
}

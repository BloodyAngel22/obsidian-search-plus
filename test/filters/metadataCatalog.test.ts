import { describe, expect, it, vi } from 'vitest';
import { MetadataCatalog } from '../../src/filters/metadataCatalog';
import { FakeVault, ManualTimers } from './fakeVault';

function setup(files: Record<string, Record<string, unknown> | undefined>, batchSize = 250) {
  const vault = new FakeVault();
  for (const [path, fm] of Object.entries(files)) vault.set(path, fm);
  const timers = new ManualTimers();
  const catalog = new MetadataCatalog(vault.app(), timers, batchSize, 0);
  return { vault, timers, catalog };
}

describe('MetadataCatalog discovery', () => {
  const files = {
    'a.md': {
      projects: ['mobivion', 'klikmedia', 'mobivion'],
      type: 'learn',
      priority: 3,
      enabled: true,
      empty_text: '',
      empty_list: [],
      null_value: null,
      nested: { k: 'v' },
      'Свойство: с двоеточием': 'Значение',
    },
    'b.md': {
      projects: 'mobivion',
      type: 'project',
      priority: '3',
      Status: 'Done',
      status: 'done',
    },
    'c.md': undefined,
    'image.png': { ignored: true },
  };

  it('discovers every YAML property with counts, shapes and typed values', () => {
    const { catalog, timers } = setup(files);
    catalog.start();
    timers.runAll();
    expect(catalog.getState().state).toBe('ready');
    const projects = catalog.getProperty('projects')!;
    expect(projects.noteCount).toBe(2);
    expect([...projects.shapes.keys()].sort()).toEqual(['list', 'string']);
    expect(catalog.valueCount('projects', 'mobivion')).toBe(2);
    expect(catalog.valueCount('projects', 'klikmedia')).toBe(1);
    expect(catalog.valueCount('priority', 3)).toBe(1);
    expect(catalog.valueCount('priority', '3')).toBe(1);
    expect(catalog.valueCount('enabled', true)).toBe(1);
    expect(catalog.valueCount('empty_text', '')).toBe(1);
    expect(catalog.valueCount('null_value', null)).toBe(1);
    expect(catalog.getProperty('empty_list')!.distinctValues).toBe(0);
    expect(catalog.getProperty('nested')!.shapes.has('object')).toBe(true);
    expect(catalog.getProperty('Свойство: с двоеточием')).toBeDefined();
    expect(catalog.getProperty('ignored')).toBeUndefined();
  });

  it('keeps keys differing only in case separate and reports the variants', () => {
    const { catalog, timers } = setup(files);
    catalog.start();
    timers.runAll();
    expect(catalog.getProperty('Status')!.caseVariants).toEqual(['status']);
    expect(catalog.getProperty('status')!.caseVariants).toEqual(['Status']);
  });

  it('never imports inline (Dataview-style) fields: only MetadataCache frontmatter counts', () => {
    // MetadataCache exposes `status:: done` in the body as no frontmatter at all.
    const { catalog, timers } = setup({ 'inline.md': undefined });
    catalog.start();
    timers.runAll();
    expect(catalog.getProperties()).toEqual([]);
  });

  it('ignores the legacy position entry of old Obsidian versions', () => {
    const { catalog, timers } = setup({
      'old.md': { position: { start: { line: 0 }, end: { line: 2 } }, type: 'x' },
    });
    catalog.start();
    timers.runAll();
    expect(catalog.getProperties().map((p) => p.name)).toEqual(['type']);
  });

  it('searches property names and values with bounded results', () => {
    const many: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 3000; i++) many[`n${i}.md`] = { tag: `value-${i}`, kind: 'k' };
    const { catalog, timers } = setup(many, 500);
    catalog.start();
    timers.runAll();
    expect(catalog.searchProperties('ta', 10).map((p) => p.name)).toEqual(['tag']);
    const page = catalog.searchValues('tag', 'value-1', 50);
    expect(page.values).toHaveLength(50);
    expect(page.total).toBe(1111);
  });
});

describe('MetadataCatalog initial scan', () => {
  it('scans in batches on timers instead of blocking', () => {
    const files: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 10; i++) files[`n${i}.md`] = { k: i };
    const { catalog, timers } = setup(files, 3);
    catalog.start();
    expect(catalog.getState().state).toBe('scanning');
    expect(catalog.getProperties()).toEqual([]);
    timers.tick();
    expect(catalog.getState().scanned).toBe(3);
    timers.runAll();
    expect(catalog.getState()).toEqual({ state: 'ready', scanned: 10, total: 10 });
    expect(catalog.getProperty('k')!.noteCount).toBe(10);
  });
});

describe('MetadataCatalog incremental updates', () => {
  function ready() {
    const ctx = setup({ 'a.md': { type: 'learn', projects: ['x'] }, 'b.md': { type: 'learn' } });
    ctx.catalog.start();
    ctx.timers.runAll();
    return ctx;
  }

  it('replaces a note contribution when its properties change', () => {
    const { vault, catalog, timers } = ready();
    const listener = vi.fn();
    catalog.onChange(listener);
    vault.edit('a.md', { type: 'project' });
    timers.runAll();
    expect(catalog.valueCount('type', 'learn')).toBe(1);
    expect(catalog.valueCount('type', 'project')).toBe(1);
    expect(catalog.getProperty('projects')).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('adds created notes and removes deleted ones', () => {
    const { vault, catalog } = ready();
    vault.edit('new.md', { status: 'open' });
    expect(catalog.getProperty('status')!.noteCount).toBe(1);
    vault.remove('new.md');
    expect(catalog.getProperty('status')).toBeUndefined();
    vault.remove('a.md');
    expect(catalog.getProperty('type')!.noteCount).toBe(1);
  });

  it('follows renames without double counting', () => {
    const { vault, catalog } = ready();
    vault.rename('a.md', 'folder/a2.md');
    expect(catalog.getProperty('type')!.noteCount).toBe(2);
    expect(catalog.samplePathsWithField('projects', 5)).toEqual(['folder/a2.md']);
    vault.remove('folder/a2.md');
    expect(catalog.getProperty('projects')).toBeUndefined();
  });

  it('coalesces bursts of edits into one change notification', () => {
    const { vault, catalog, timers } = ready();
    const listener = vi.fn();
    catalog.onChange(listener);
    for (let i = 0; i < 20; i++) vault.edit('a.md', { type: `t${i}` });
    timers.runAll();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(catalog.valueCount('type', 't19')).toBe(1);
    expect(catalog.valueCount('type', 't0')).toBe(0);
  });

  it('unregisters every event on stop', () => {
    const { vault, catalog } = ready();
    catalog.stop();
    expect(vault.cacheEvents.count('changed')).toBe(0);
    expect(vault.vaultEvents.count('rename')).toBe(0);
  });
});

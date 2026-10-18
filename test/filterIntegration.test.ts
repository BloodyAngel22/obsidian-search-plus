/**
 * SearchModal and SearchPanelView with the shared metadata filter services: the same
 * store drives both, filter-only search works with an empty query, incompatible
 * engines are reported instead of searched, and metadata pages can be extended.
 */
import { App, Scope, TFile, WorkspaceLeaf } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineCapabilityCache } from '../src/filters/engineCompat';
import { FilterStore } from '../src/filters/filterStore';
import { MetadataCatalog } from '../src/filters/metadataCatalog';
import { MetadataMenuAdapter } from '../src/filters/metadataMenu';
import type { FilterServices } from '../src/filters/services';
import type { SearchResult } from '../src/ipc';
import { DEFAULT_SETTINGS } from '../src/settings';
import { SearchModal } from '../src/ui/SearchModal';
import { SearchPanelView } from '../src/ui/SearchPanelView';
import { FakeVault, ManualTimers } from './filters/fakeVault';

const MODERN = {
  apiVersion: 2,
  capabilities: ['structuredFiltersV1', 'metadataOnlyPagination', 'searchMeta'],
};

const result = (path: string, score = 1): SearchResult => ({
  path,
  title: path.replace('.md', ''),
  score,
  tags: [],
  aliases: [],
});

function services(): FilterServices {
  const vault = new FakeVault();
  vault.set('a.md', { projects: ['alpha'] });
  const timers = new ManualTimers();
  const catalog = new MetadataCatalog(vault.app(), timers, 100, 0);
  catalog.start();
  timers.runAll();
  return {
    store: new FilterStore(undefined, vi.fn(), 10_000),
    catalog,
    metadataMenu: new MetadataMenuAdapter(vault.app()),
    capabilities: new EngineCapabilityCache(),
  };
}

function modernClient() {
  return {
    search: vi.fn().mockResolvedValue([result('legacy.md', 0.5)]),
    getCapabilities: vi.fn().mockResolvedValue(MODERN),
    searchWithMeta: vi.fn().mockResolvedValue({
      results: [result('a.md'), result('b.md')],
      meta: { kind: 'metadata', total: 120, totalExact: true, hasMore: true, nextOffset: 2 },
    }),
  };
}

function modalApp() {
  const app = new App() as App & Record<string, unknown>;
  Object.assign(app, {
    workspace: { getLeaf: vi.fn(), getLastOpenFiles: vi.fn().mockReturnValue([]) },
    vault: {
      cachedRead: vi.fn().mockResolvedValue(''),
      getAbstractFileByPath: vi.fn().mockReturnValue(Object.assign(new TFile(), { path: 'a.md' })),
    },
    metadataCache: { getCache: vi.fn().mockReturnValue(null), resolvedLinks: {} },
  });
  return app;
}

/** The mock SuggestModal has no DOM; give it the elements the real one owns. */
function attachModalDom(modal: SearchModal): HTMLInputElement {
  const m = modal as unknown as Record<string, unknown>;
  const modalEl = activeDocument.createDiv();
  const inputContainer = modalEl.createDiv({ cls: 'prompt-input-container' });
  const inputEl = inputContainer.createEl('input');
  const resultContainerEl = modalEl.createDiv({ cls: 'prompt-results' });
  m.modalEl = modalEl;
  m.containerEl = modalEl;
  m.inputEl = inputEl;
  m.resultContainerEl = resultContainerEl;
  m.scope = new Scope();
  return inputEl;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('SearchModal with metadata filters', () => {
  let shared: FilterServices;
  beforeEach(() => {
    shared = services();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  function openModal(client: ReturnType<typeof modernClient> | Record<string, unknown>) {
    const modal = new SearchModal(
      modalApp() as never,
      client as never,
      { ...DEFAULT_SETTINGS },
      vi.fn(),
      {
        filters: shared,
      },
    );
    const inputEl = attachModalDom(modal);
    modal.open();
    return { modal, inputEl };
  }

  it('renders the filter bar between the input and the results', () => {
    const { modal } = openModal(modernClient());
    const modalEl = (modal as unknown as { modalEl: HTMLElement }).modalEl;
    const bar = modalEl.querySelector('.search-plus-filter-bar');
    expect(bar).not.toBeNull();
    expect(bar!.nextElementSibling?.classList.contains('prompt-results')).toBe(true);
    modal.onClose();
  });

  it('runs a metadata-only search for an empty query with active filters', async () => {
    const client = modernClient();
    const { modal } = openModal(client);
    const row = shared.store.addRow('projects')!;
    shared.store.toggleValue(row.id, 'alpha');
    const pending = modal.getSuggestions('');
    await vi.runAllTimersAsync();
    const results = await pending;
    expect(results.map((r) => r.path)).toEqual(['a.md', 'b.md']);
    expect(client.searchWithMeta).toHaveBeenLastCalledWith(
      '',
      expect.objectContaining({
        limit: 50,
        filters: {
          version: 1,
          operator: 'AND',
          conditions: [{ field: 'projects', operator: 'IN', values: ['alpha'] }],
        },
      }),
    );
    // Metadata results have no relevance score to show.
    const el = activeDocument.createDiv();
    modal.renderSuggestion(results[0]!, el);
    expect(el.querySelector('.hybrid-search-score')).toBeNull();
    const modalEl = (modal as unknown as { modalEl: HTMLElement }).modalEl;
    expect(modalEl.querySelector('.search-plus-filter-status')!.textContent).toBe(
      '120 notes match · showing 2',
    );
    modal.onClose();
  });

  it('keeps the old empty-query behaviour while filters are incomplete', async () => {
    const client = modernClient();
    const { modal } = openModal(client);
    shared.store.addRow('projects');
    const results = await modal.getSuggestions('');
    expect(results).toEqual([]);
    expect(client.searchWithMeta).not.toHaveBeenCalled();
    modal.onClose();
  });

  it('reports an outdated engine and does not search without the filters', async () => {
    const client = {
      search: vi.fn().mockResolvedValue([result('unfiltered.md')]),
      getCapabilities: vi.fn().mockResolvedValue({ apiVersion: 1, capabilities: [] }),
      searchWithMeta: vi.fn(),
    };
    const { modal } = openModal(client);
    const row = shared.store.addRow('projects')!;
    shared.store.toggleValue(row.id, 'alpha');
    const pending = modal.getSuggestions('redis');
    await vi.runAllTimersAsync();
    expect(await pending).toEqual([]);
    expect(client.search).not.toHaveBeenCalledWith('redis', expect.anything());
    expect(client.searchWithMeta).not.toHaveBeenCalled();
    expect((modal as unknown as { emptyStateText: string }).emptyStateText).toMatch(
      /Update Search Plus Engine/,
    );
    modal.onClose();
  });

  it('re-runs the query whenever the shared filters change', () => {
    const { modal, inputEl } = openModal(modernClient());
    const onInput = vi.fn();
    inputEl.addEventListener('input', onInput);
    const row = shared.store.addRow('projects')!;
    shared.store.toggleValue(row.id, 'alpha');
    expect(onInput).toHaveBeenCalledTimes(2);
    modal.onClose();
    shared.store.removeRow(row.id);
    expect(onInput).toHaveBeenCalledTimes(2);
  });

  it('uses the mode picked in the filter bar', async () => {
    const client = modernClient();
    const { modal } = openModal(client);
    const modalEl = (modal as unknown as { modalEl: HTMLElement }).modalEl;
    const select = modalEl.querySelector<HTMLSelectElement>('.search-plus-mode-select')!;
    select.value = 'fulltext';
    select.dispatchEvent(new Event('change'));
    const pending = modal.getSuggestions('redis');
    await vi.runAllTimersAsync();
    await pending;
    expect(client.search).toHaveBeenLastCalledWith(
      'redis',
      expect.objectContaining({ mode: 'fulltext' }),
    );
    modal.onClose();
  });
});

describe('SearchPanelView with metadata filters', () => {
  let shared: FilterServices;
  beforeEach(() => {
    shared = services();
  });

  function makeView(client: ReturnType<typeof modernClient>) {
    const app = {
      workspace: {
        getActiveFile: () => null,
        getLeavesOfType: () => [],
        getLeaf: () => ({ openFile: vi.fn() }),
      },
      vault: { getAbstractFileByPath: () => null },
      metadataCache: { getCache: () => null },
      keymap: { pushScope: vi.fn(), popScope: vi.fn() },
    };
    const leaf = Object.assign(new WorkspaceLeaf(), { app });
    const plugin = {
      manifest: { id: 'hybrid-search' },
      app,
      settings: { ...DEFAULT_SETTINGS },
      client,
      filterServices: shared,
      saveSettings: vi.fn(),
    };
    return new SearchPanelView(leaf, plugin as never);
  }

  it('runs a filter-only search on open, hides scores and loads more pages', async () => {
    const row = shared.store.addRow('projects')!;
    shared.store.toggleValue(row.id, 'alpha');
    const client = modernClient();
    const view = makeView(client);
    await view.onOpen();
    await flush();
    const rows = () => view.containerEl.querySelectorAll('.hybrid-search-panel-row');
    expect(rows()).toHaveLength(2);
    expect(view.containerEl.querySelector('.hybrid-search-panel-score')).toBeNull();
    expect(view.containerEl.querySelector('.search-plus-filter-status')!.textContent).toBe(
      '120 notes match · showing 2',
    );

    client.searchWithMeta.mockResolvedValueOnce({
      results: [result('c.md')],
      meta: { kind: 'metadata', total: 120, totalExact: true, hasMore: false, nextOffset: null },
    });
    view.containerEl.querySelector<HTMLButtonElement>('.search-plus-load-more')!.click();
    await flush();
    expect(client.searchWithMeta).toHaveBeenLastCalledWith(
      '',
      expect.objectContaining({ offset: 2 }),
    );
    expect(rows()).toHaveLength(3);
    expect(view.containerEl.querySelector('.search-plus-load-more')).toBeNull();
    await view.onClose();
  });

  it('keeps sensible behaviour for an empty query without filters', async () => {
    const client = modernClient();
    const view = makeView(client);
    await view.onOpen();
    await (view as unknown as { search: (q: string) => Promise<void> }).search('');
    expect(view.containerEl.textContent).toContain('Type to search.');
    expect(client.searchWithMeta).not.toHaveBeenCalled();
    expect(client.search).not.toHaveBeenCalled();
    await view.onClose();
  });

  it('re-searches when the shared store changes from another view', async () => {
    vi.useFakeTimers();
    const client = modernClient();
    const view = makeView(client);
    await view.onOpen();
    const row = shared.store.addRow('projects')!;
    shared.store.toggleValue(row.id, 'alpha');
    await vi.advanceTimersByTimeAsync(200);
    expect(client.searchWithMeta).toHaveBeenCalledTimes(1);
    await view.onClose();
    vi.useRealTimers();
  });

  it('does not let an older response overwrite newer results', async () => {
    const row = shared.store.addRow('projects')!;
    shared.store.toggleValue(row.id, 'alpha');
    let resolveOld!: (v: unknown) => void;
    const client = modernClient();
    client.searchWithMeta
      .mockImplementationOnce(() => new Promise((r) => (resolveOld = r)))
      .mockResolvedValueOnce({ results: [result('new.md')], meta: { total: 1, totalExact: true } });
    const view = makeView(client);
    await view.onOpen();
    const search = (view as unknown as { search: (q: string) => Promise<void> }).search.bind(view);
    shared.store.toggleValue(row.id, 'beta');
    await search('');
    resolveOld({ results: [result('old.md')], meta: { total: 1, totalExact: true } });
    await flush();
    expect(view.containerEl.textContent).toContain('new');
    expect(view.containerEl.textContent).not.toContain('old');
    await view.onClose();
  });
});

describe('Compact filter UI shared by the modal and the panel', () => {
  it('a value picked in the modal popover shows in the panel and gives both the same filters', async () => {
    vi.useFakeTimers();
    const shared = services();
    const modalClient = modernClient();
    const modal = new SearchModal(
      modalApp() as never,
      modalClient as never,
      { ...DEFAULT_SETTINGS },
      vi.fn(),
      { filters: shared },
    );
    attachModalDom(modal);
    modal.open();

    const panelClient = modernClient();
    const app = {
      workspace: {
        getActiveFile: () => null,
        getLeavesOfType: () => [],
        getLeaf: () => ({ openFile: vi.fn() }),
      },
      vault: { getAbstractFileByPath: () => null },
      metadataCache: { getCache: () => null },
      keymap: { pushScope: vi.fn(), popScope: vi.fn() },
    };
    const leaf = Object.assign(new WorkspaceLeaf(), { app });
    const view = new SearchPanelView(leaf, {
      manifest: { id: 'hybrid-search' },
      app,
      settings: { ...DEFAULT_SETTINGS },
      client: panelClient,
      filterServices: shared,
      saveSettings: vi.fn(),
    } as never);
    await view.onOpen();

    const modalEl = (modal as unknown as { modalEl: HTMLElement }).modalEl;
    modalEl.querySelector<HTMLButtonElement>('.search-plus-add-filter')!.click();
    const picker = activeDocument.querySelector<HTMLInputElement>(
      '.search-plus-floating-popover .search-plus-popover-input',
    )!;
    picker.value = 'projects';
    picker.dispatchEvent(new Event('input'));
    picker.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    activeDocument
      .querySelector<HTMLElement>('.search-plus-floating-popover .search-plus-popover-item')!
      .click();
    expect(shared.store.getRows()).toEqual([
      expect.objectContaining({ field: 'projects', operator: 'IN', values: ['alpha'] }),
    ]);
    expect(view.containerEl.querySelector('.search-plus-filter-value')!.textContent).toBe('alpha');

    // The mock SuggestModal does not re-query on input events; run the query directly.
    const pending = modal.getSuggestions('');
    await vi.advanceTimersByTimeAsync(400);
    await pending;
    await flush();
    const modalFilters = modalClient.searchWithMeta.mock.lastCall?.[1]?.filters;
    const panelFilters = panelClient.searchWithMeta.mock.lastCall?.[1]?.filters;
    expect(modalFilters).toEqual({
      version: 1,
      operator: 'AND',
      conditions: [{ field: 'projects', operator: 'IN', values: ['alpha'] }],
    });
    expect(panelFilters).toEqual(modalFilters);

    modal.onClose();
    await view.onClose();
    expect(activeDocument.querySelector('.search-plus-floating-popover')).toBeNull();
    vi.useRealTimers();
  });
});

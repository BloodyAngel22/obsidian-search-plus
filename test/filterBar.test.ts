import { App, Scope } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterStore } from '../src/filters/filterStore';
import { MetadataCatalog } from '../src/filters/metadataCatalog';
import { FilterBar } from '../src/ui/filters/FilterBar';
import { FakeVault, ManualTimers } from './filters/fakeVault';

/** The mock Keymap records pushed scopes; the real type does not expose them. */
function scopes(app: App): Scope[] {
  return (app.keymap as unknown as { scopes: Scope[] }).scopes;
}

function key(target: HTMLElement, keyName: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const evt = new KeyboardEvent('keydown', {
    key: keyName,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(evt);
  return evt;
}

function type(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event('input'));
}

function setup(files: Record<string, Record<string, unknown>>, withScope = false) {
  const vault = new FakeVault();
  for (const [path, fm] of Object.entries(files)) vault.set(path, fm);
  const timers = new ManualTimers();
  const catalog = new MetadataCatalog(vault.app(), timers, 1000, 0);
  catalog.start();
  timers.runAll();
  const store = new FilterStore(undefined, vi.fn(), 10_000);
  const app = new App();
  const parentScope = new Scope();
  const onEscape = vi.fn();
  const focusSearch = vi.fn();
  const setMode = vi.fn();
  const host = activeDocument.createDiv();
  activeDocument.body.appendChild(host);
  const bar = new FilterBar(host, {
    app,
    store,
    catalog,
    mode: { get: () => 'hybrid', set: setMode },
    focusSearch,
    ...(withScope && { keyScope: { parent: parentScope, onEscape } }),
  });
  return { bar, store, catalog, app, onEscape, focusSearch, setMode, host, timers, vault };
}

const files = {
  'a.md': { projects: ['mobivion', 'klikmedia'], type: 'learn', priority: 1 },
  'b.md': { projects: ['mobivion'], type: 'project', priority: '1' },
  'c.md': { status: 'done' },
};

describe('FilterBar', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup(files);
  });
  afterEach(() => {
    ctx.bar.destroy();
    ctx.host.remove();
  });

  const q = <T extends Element>(sel: string) => ctx.host.querySelector<T>(sel);
  const qa = (sel: string) => Array.from(ctx.host.querySelectorAll<HTMLElement>(sel));

  it('starts compact: no property controls until "+ Filter" is used', () => {
    expect(qa('.search-plus-filter-row')).toHaveLength(0);
    expect(q('.search-plus-popover')).toBeNull();
    expect(q('.search-plus-mode-select')).not.toBeNull();
    expect(q('.search-plus-add-filter')?.textContent).toContain('Filter');
  });

  it('opens a searchable property picker and filters it by name', () => {
    q<HTMLButtonElement>('.search-plus-add-filter')!.click();
    const input = q<HTMLInputElement>('.search-plus-popover-input')!;
    expect(activeDocument.activeElement).toBe(input);
    const names = () => qa('.search-plus-popover-label').map((el) => el.textContent);
    expect(names()).toEqual(expect.arrayContaining(['projects', 'type', 'priority', 'status']));
    type(input, 'proj');
    expect(names()[0]).toBe('projects');
  });

  it('adds a row with Enter and opens its value list for keyboard multi-select', () => {
    q<HTMLButtonElement>('.search-plus-add-filter')!.click();
    const picker = q<HTMLInputElement>('.search-plus-popover-input')!;
    type(picker, 'projects');
    key(picker, 'Enter');
    expect(ctx.store.getRows().map((r) => r.field)).toEqual(['projects']);
    const row = q<HTMLElement>('.search-plus-filter-row')!;
    expect(row.classList.contains('is-incomplete')).toBe(true);

    const values = q<HTMLInputElement>('.search-plus-row-popover .search-plus-popover-input')!;
    expect(activeDocument.activeElement).toBe(values);
    key(values, 'Enter'); // most common value first: mobivion
    key(activeDocument.activeElement as HTMLElement, 'ArrowDown');
    key(activeDocument.activeElement as HTMLElement, 'Enter');
    expect(ctx.store.getRows()[0]!.values).toEqual(['mobivion', 'klikmedia']);
    expect(q<HTMLElement>('.search-plus-filter-row')!.classList.contains('is-active')).toBe(true);
    expect(qa('.search-plus-chip-label').map((el) => el.textContent)).toEqual([
      'mobivion',
      'klikmedia',
    ]);

    key(activeDocument.activeElement as HTMLElement, 'Escape');
    expect(q('.search-plus-popover')).toBeNull();
    expect(ctx.store.getRows()[0]!.values).toHaveLength(2);
  });

  it('accepts an exact value that no note has yet, typed by the property types', () => {
    const row = ctx.store.addRow('priority')!;
    ctx.store.toggleValue(row.id, 'placeholder');
    ctx.store.toggleValue(row.id, 'placeholder');
    q<HTMLButtonElement>('.search-plus-add-value')!.click();
    const input = q<HTMLInputElement>('.search-plus-row-popover .search-plus-popover-input')!;
    type(input, '42');
    expect(qa('.search-plus-popover-detail')[0]!.textContent).toBe('use exact value');
    key(input, 'Enter');
    // priority is seen as number and string, so typed text stays a string.
    expect(ctx.store.getRows()[0]!.values).toEqual(['42']);
  });

  it('shows number and string values with the same text as different choices', () => {
    const row = ctx.store.addRow('priority')!;
    void row;
    q<HTMLButtonElement>('.search-plus-add-value')!.click();
    const labels = qa('.search-plus-row-popover .search-plus-popover-item').map(
      (el) => el.textContent,
    );
    expect(labels.some((t) => t?.includes('number'))).toBe(true);
    expect(labels.filter((t) => t?.startsWith('1')).length).toBe(2);
  });

  it('keeps a selected value that disappeared from the vault, marked as missing', () => {
    const row = ctx.store.addRow('type')!;
    ctx.store.toggleValue(row.id, 'learn');
    ctx.vault.edit('a.md', { type: 'archive' });
    ctx.timers.runAll();
    expect(ctx.store.getRows()[0]!.values).toEqual(['learn']);
    expect(q('.search-plus-chip.is-missing')).not.toBeNull();
    expect(q('.search-plus-filter-row')!.classList.contains('has-no-match')).toBe(true);
  });

  it('removes values, rows and all filters', () => {
    const row = ctx.store.addRow('projects')!;
    ctx.store.toggleValue(row.id, 'mobivion');
    ctx.store.addRow('status');
    q<HTMLButtonElement>('.search-plus-chip-remove')!.click();
    expect(ctx.store.getRows()[0]!.values).toEqual([]);
    q<HTMLButtonElement>('.search-plus-remove-filter')!.click();
    expect(ctx.store.getRows().map((r) => r.field)).toEqual(['status']);
    q<HTMLButtonElement>('.search-plus-clear-filters')!.click();
    expect(ctx.store.getRows()).toEqual([]);
    expect(ctx.focusSearch).toHaveBeenCalled();
  });

  it('changes the operator, and EXISTS needs no values', () => {
    const row = ctx.store.addRow('status')!;
    const select = q<HTMLSelectElement>('.search-plus-operator-select')!;
    select.value = 'EXISTS';
    select.dispatchEvent(new Event('change'));
    expect(ctx.store.getRows()[0]!.operator).toBe('EXISTS');
    expect(q('.search-plus-filter-row')!.classList.contains('is-active')).toBe(true);
    expect(q('.search-plus-add-value')).toBeNull();
    void row;
  });

  it('forwards mode changes', () => {
    const select = q<HTMLSelectElement>('.search-plus-mode-select')!;
    select.value = 'semantic';
    select.dispatchEvent(new Event('change'));
    expect(ctx.setMode).toHaveBeenCalledWith('semantic');
  });

  it('stops keys typed inside the bar from reaching host result navigation', () => {
    const hostListener = vi.fn();
    ctx.host.addEventListener('keydown', hostListener);
    q<HTMLButtonElement>('.search-plus-add-filter')!.click();
    key(q<HTMLInputElement>('.search-plus-popover-input')!, 'ArrowDown');
    key(q<HTMLButtonElement>('.search-plus-add-filter')!, 'j', { ctrlKey: true });
    expect(hostListener).not.toHaveBeenCalled();
  });

  it('renders a bounded number of values for huge properties', () => {
    ctx.bar.destroy();
    const many: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 5000; i++) many[`n${i}.md`] = { id: `v${i}` };
    ctx = setup(many);
    ctx.store.addRow('id');
    q<HTMLButtonElement>('.search-plus-add-value')!.click();
    expect(qa('.search-plus-popover-item').length).toBeLessThanOrEqual(51);
    expect(q('.search-plus-popover-more')!.textContent).toMatch(/4950 more/);
  });

  it('shows host status text and a footer action', () => {
    const action = vi.fn();
    ctx.bar.setStatus('12 notes match');
    ctx.bar.setFooterAction('Load more', action);
    expect(q('.search-plus-filter-status')!.textContent).toBe('12 notes match');
    q<HTMLButtonElement>('.search-plus-footer-action')!.click();
    expect(action).toHaveBeenCalled();
  });
});

describe('FilterBar keyboard scope (search modal)', () => {
  it('pushes a scope while focused so modal keys do not act on results', () => {
    const ctx = setup(files, true);
    const button = ctx.host.querySelector<HTMLButtonElement>('.search-plus-add-filter')!;
    button.focus();
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(scopes(ctx.app)).toHaveLength(1);
    const scope = scopes(ctx.app)[0]!;
    const arrow = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
    expect((scope as unknown as { handleKey(e: KeyboardEvent): unknown }).handleKey(arrow)).toBe(
      true,
    );
    expect(arrow.defaultPrevented).toBe(false);

    // Escape with an open list closes the list, not the modal.
    ctx.bar.openPicker();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    (scope as unknown as { handleKey(e: KeyboardEvent): unknown }).handleKey(escape);
    expect(ctx.bar.isPopoverOpen()).toBe(false);
    expect(ctx.onEscape).not.toHaveBeenCalled();

    // Escape without an open list closes the modal.
    button.focus();
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    const scope2 = scopes(ctx.app)[0]!;
    (scope2 as unknown as { handleKey(e: KeyboardEvent): unknown }).handleKey(
      new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }),
    );
    expect(ctx.onEscape).toHaveBeenCalledTimes(1);
    ctx.bar.destroy();
    expect(scopes(ctx.app)).toHaveLength(0);
    ctx.host.remove();
  });

  it('releases the scope when focus leaves the bar', () => {
    const ctx = setup(files, true);
    const button = ctx.host.querySelector<HTMLButtonElement>('.search-plus-add-filter')!;
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(scopes(ctx.app)).toHaveLength(1);
    button.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    expect(scopes(ctx.app)).toHaveLength(0);
    ctx.bar.destroy();
    ctx.host.remove();
  });
});

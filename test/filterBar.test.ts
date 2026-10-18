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

function handleKey(scope: Scope, evt: KeyboardEvent): unknown {
  return (scope as unknown as { handleKey(e: KeyboardEvent): unknown }).handleKey(evt);
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
  'b.md': { projects: ['mobivion', 'alpha', 'beta'], type: 'project', priority: '1' },
  'c.md': { status: 'done' },
};

/** Popovers live at document-body level, outside the bar's host. */
const pop = <T extends Element>(sel: string) =>
  activeDocument.querySelector<T>(`.search-plus-floating-popover ${sel}`);
const popAll = (sel: string) =>
  Array.from(activeDocument.querySelectorAll<HTMLElement>(`.search-plus-floating-popover ${sel}`));

describe('FilterBar', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup(files);
  });
  afterEach(() => {
    ctx.bar.destroy();
    ctx.host.remove();
    expect(activeDocument.querySelector('.search-plus-floating-popover')).toBeNull();
  });

  const q = <T extends Element>(sel: string) => ctx.host.querySelector<T>(sel);
  const qa = (sel: string) => Array.from(ctx.host.querySelectorAll<HTMLElement>(sel));

  it('starts compact: only the mode dropdown and "+ Filter"', () => {
    expect(qa('.search-plus-filter-row')).toHaveLength(0);
    expect(activeDocument.querySelector('.search-plus-floating-popover')).toBeNull();
    expect(q('.search-plus-mode-select')).not.toBeNull();
    expect(q('.search-plus-add-filter')?.textContent).toContain('Filter');
    expect(q<HTMLElement>('.search-plus-clear-filters')!.style.display).toBe('none');
  });

  it('opens a floating property picker outside the bar and filters it by name', () => {
    q<HTMLButtonElement>('.search-plus-add-filter')!.click();
    const popover = activeDocument.querySelector('.search-plus-floating-popover')!;
    // Floats at body level: it never pushes the results down or gets clipped.
    expect(popover.parentElement).toBe(activeDocument.body);
    expect(ctx.host.contains(popover)).toBe(false);
    const input = pop<HTMLInputElement>('.search-plus-popover-input')!;
    expect(activeDocument.activeElement).toBe(input);
    const names = () => popAll('.search-plus-popover-label').map((el) => el.textContent);
    expect(names()).toEqual(expect.arrayContaining(['projects', 'type', 'priority', 'status']));
    type(input, 'proj');
    expect(names()[0]).toBe('projects');
  });

  it('adds a row with Enter and opens its value popover for keyboard multi-select', () => {
    q<HTMLButtonElement>('.search-plus-add-filter')!.click();
    const picker = pop<HTMLInputElement>('.search-plus-popover-input')!;
    type(picker, 'projects');
    key(picker, 'Enter');
    expect(ctx.store.getRows().map((r) => r.field)).toEqual(['projects']);
    const row = q<HTMLElement>('.search-plus-filter-row')!;
    expect(row.classList.contains('is-incomplete')).toBe(true);
    expect(q('.search-plus-filter-value')!.textContent).toBe('Select value');

    const values = pop<HTMLInputElement>('.search-plus-popover-input')!;
    expect(activeDocument.querySelector('.search-plus-row-popover')).not.toBeNull();
    expect(activeDocument.activeElement).toBe(values);
    key(values, 'Enter'); // most common value first: mobivion
    key(values, 'ArrowDown');
    key(values, 'Enter');
    const selected = ctx.store.getRows()[0]!.values;
    expect(selected).toHaveLength(2);
    expect(selected[0]).toBe('mobivion');
    expect(q<HTMLElement>('.search-plus-filter-row')!.classList.contains('is-active')).toBe(true);
    // The row stays one line: two values are named, the popover lists them as chips.
    expect(q('.search-plus-filter-value')!.textContent).toBe(selected.join(', '));
    expect(popAll('.search-plus-chip-label').map((el) => el.textContent)).toEqual(selected);
    expect(pop('.search-plus-popover-count')!.textContent).toBe('2 selected');

    key(values, 'Escape');
    expect(activeDocument.querySelector('.search-plus-floating-popover')).toBeNull();
    expect(ctx.store.getRows()[0]!.values).toHaveLength(2);
    // Focus goes back to the control that opened the popover.
    expect(activeDocument.activeElement).toBe(q('.search-plus-filter-value'));
  });

  it('shows a count instead of names when more than two values are selected', () => {
    const row = ctx.store.addRow('projects')!;
    for (const v of ['mobivion', 'klikmedia', 'alpha']) ctx.store.toggleValue(row.id, v);
    const button = q<HTMLElement>('.search-plus-filter-value')!;
    expect(button.textContent).toBe('3 selected');
    expect(button.getAttribute('title')).toBe('mobivion, klikmedia, alpha');
  });

  it('keeps long names in the tooltip (CSS truncates the visible text)', () => {
    const longField = 'a-very-long-property-name-that-would-not-fit-in-a-narrow-sidebar';
    const longValue = 'a value that is much longer than the space a compact row can give';
    const row = ctx.store.addRow(longField)!;
    ctx.store.toggleValue(row.id, longValue);
    expect(q('.search-plus-filter-field')!.getAttribute('title')).toBe(longField);
    expect(q('.search-plus-filter-value')!.getAttribute('title')).toBe(longValue);
  });

  it('removes one selected value from the popover and clears a field', () => {
    const row = ctx.store.addRow('projects')!;
    ctx.store.toggleValue(row.id, 'mobivion');
    ctx.store.toggleValue(row.id, 'klikmedia');
    q<HTMLButtonElement>('.search-plus-filter-value')!.click();
    pop<HTMLButtonElement>('.search-plus-chip-remove')!.click();
    expect(ctx.store.getRows()[0]!.values).toEqual(['klikmedia']);
    expect(pop('.search-plus-popover-count')!.textContent).toBe('1 selected');
    pop<HTMLButtonElement>('.search-plus-clear-values')!.click();
    expect(ctx.store.getRows()[0]!.values).toEqual([]);
    expect(q<HTMLElement>('.search-plus-filter-row')!.classList.contains('is-incomplete')).toBe(
      true,
    );
    // Still open for picking again, focus kept in the search box of the popover.
    expect(activeDocument.activeElement).toBe(pop('.search-plus-popover-input'));
  });

  it('accepts an exact value that no note has yet, typed by the property types', () => {
    ctx.store.addRow('priority');
    q<HTMLButtonElement>('.search-plus-filter-value')!.click();
    const input = pop<HTMLInputElement>('.search-plus-popover-input')!;
    type(input, '42');
    expect(popAll('.search-plus-popover-detail')[0]!.textContent).toBe('use exact value');
    key(input, 'Enter');
    // priority is seen as number and string, so typed text stays a string.
    expect(ctx.store.getRows()[0]!.values).toEqual(['42']);
  });

  it('shows number and string values with the same text as different choices', () => {
    ctx.store.addRow('priority');
    q<HTMLButtonElement>('.search-plus-filter-value')!.click();
    const labels = popAll('.search-plus-popover-item').map((el) => el.textContent);
    expect(labels.some((t) => t?.includes('number'))).toBe(true);
    expect(labels.filter((t) => t?.startsWith('1')).length).toBe(2);
  });

  it('keeps a selected value that disappeared from the vault, marked as missing', () => {
    const row = ctx.store.addRow('type')!;
    ctx.store.toggleValue(row.id, 'learn');
    ctx.vault.edit('a.md', { type: 'archive' });
    ctx.timers.runAll();
    expect(ctx.store.getRows()[0]!.values).toEqual(['learn']);
    const rowEl = q<HTMLElement>('.search-plus-filter-row')!;
    expect(rowEl.classList.contains('has-no-match')).toBe(true);
    expect(rowEl.getAttribute('title')).toBe('No note has these values now.');
    expect(q('.search-plus-filter-value')!.classList.contains('has-missing')).toBe(true);
    q<HTMLButtonElement>('.search-plus-filter-value')!.click();
    expect(pop('.search-plus-chip.is-missing')).not.toBeNull();
  });

  it('marks invalid rows with a visible message and never as active', () => {
    const row = ctx.store.addRow('projects')!;
    ctx.store.toggleValue(row.id, 'x'.repeat(5000));
    const rowEl = q<HTMLElement>('.search-plus-filter-row')!;
    expect(rowEl.classList.contains('is-invalid')).toBe(true);
    expect(q<HTMLElement>('.search-plus-filter-message')!.textContent).not.toBe('');
  });

  it('removes rows and all filters', () => {
    ctx.store.addRow('projects');
    ctx.store.addRow('status');
    q<HTMLButtonElement>('.search-plus-remove-filter')!.click();
    expect(ctx.store.getRows().map((r) => r.field)).toEqual(['status']);
    q<HTMLButtonElement>('.search-plus-clear-filters')!.click();
    expect(ctx.store.getRows()).toEqual([]);
    expect(qa('.search-plus-filter-row')).toHaveLength(0);
    expect(ctx.focusSearch).toHaveBeenCalled();
  });

  it('changes the operator, and EXISTS needs no values', () => {
    ctx.store.addRow('status');
    const select = q<HTMLSelectElement>('.search-plus-operator-select')!;
    select.value = 'EXISTS';
    select.dispatchEvent(new Event('change'));
    expect(ctx.store.getRows()[0]!.operator).toBe('EXISTS');
    expect(q('.search-plus-filter-row')!.classList.contains('is-active')).toBe(true);
    expect(q<HTMLElement>('.search-plus-filter-value')!.style.display).toBe('none');
  });

  it('closes an open value popover when the operator stops taking values', () => {
    ctx.store.addRow('status');
    q<HTMLButtonElement>('.search-plus-filter-value')!.click();
    expect(ctx.bar.isPopoverOpen()).toBe(true);
    ctx.store.setOperator(ctx.store.getRows()[0]!.id, 'MISSING');
    expect(ctx.bar.isPopoverOpen()).toBe(false);
  });

  it('updates rows in place: other rows and the open popover are not rebuilt', () => {
    const a = ctx.store.addRow('projects')!;
    ctx.store.addRow('type');
    const [rowA, rowB] = qa('.search-plus-filter-row');
    q<HTMLButtonElement>('.search-plus-filter-value')!.click();
    const input = pop<HTMLInputElement>('.search-plus-popover-input')!;
    type(input, 'o');
    key(input, 'ArrowDown');
    const list = pop<HTMLElement>('.search-plus-popover-list')!;
    list.scrollTop = 40;
    ctx.store.toggleValue(a.id, 'mobivion');
    const [afterA, afterB] = qa('.search-plus-filter-row');
    expect(afterA).toBe(rowA);
    expect(afterB).toBe(rowB);
    expect(pop('.search-plus-popover-input')).toBe(input);
    expect(input.value).toBe('o');
    expect(activeDocument.activeElement).toBe(input);
    expect(list.scrollTop).toBe(40);
    expect(popAll('.search-plus-popover-item')[1]!.classList.contains('is-active')).toBe(true);
  });

  it('keeps row order in sync with the store', () => {
    ctx.store.addRow('projects');
    const second = ctx.store.addRow('type')!;
    ctx.store.removeRow(ctx.store.getRows()[0]!.id);
    ctx.store.addRow('status');
    expect(qa('.search-plus-filter-row').map((el) => el.dataset.field)).toEqual(['type', 'status']);
    expect(qa('.search-plus-filter-row')[0]!.dataset.rowId).toBe(second.id);
  });

  it('closes the popover on a click outside without stealing focus', () => {
    ctx.store.addRow('projects');
    q<HTMLButtonElement>('.search-plus-filter-value')!.click();
    const outside = activeDocument.body.createEl('button', { text: 'elsewhere' });
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(ctx.bar.isPopoverOpen()).toBe(false);
    expect(ctx.focusSearch).not.toHaveBeenCalled();
    outside.remove();
  });

  it('does not close on clicks inside the popover or the bar', () => {
    ctx.store.addRow('projects');
    q<HTMLButtonElement>('.search-plus-filter-value')!.click();
    pop<HTMLElement>('.search-plus-popover-list')!.dispatchEvent(
      new Event('pointerdown', { bubbles: true }),
    );
    q<HTMLElement>('.search-plus-filter-field')!.dispatchEvent(
      new Event('pointerdown', { bubbles: true }),
    );
    expect(ctx.bar.isPopoverOpen()).toBe(true);
  });

  it('toggles the value popover from its row button and restores focus', () => {
    ctx.store.addRow('projects');
    const button = q<HTMLButtonElement>('.search-plus-filter-value')!;
    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    button.click();
    expect(ctx.bar.isPopoverOpen()).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(activeDocument.activeElement).toBe(button);
  });

  it('Tab closes the popover and returns focus to its trigger', () => {
    q<HTMLButtonElement>('.search-plus-add-filter')!.click();
    key(pop<HTMLInputElement>('.search-plus-popover-input')!, 'Tab');
    expect(ctx.bar.isPopoverOpen()).toBe(false);
    expect(activeDocument.activeElement).toBe(q('.search-plus-add-filter'));
  });

  it('forwards mode changes', () => {
    const select = q<HTMLSelectElement>('.search-plus-mode-select')!;
    select.value = 'semantic';
    select.dispatchEvent(new Event('change'));
    expect(ctx.setMode).toHaveBeenCalledWith('semantic');
  });

  it('stops keys typed inside the bar and popover from reaching host navigation', () => {
    const hostListener = vi.fn();
    ctx.host.addEventListener('keydown', hostListener);
    activeDocument.body.addEventListener('keydown', hostListener);
    q<HTMLButtonElement>('.search-plus-add-filter')!.click();
    key(pop<HTMLInputElement>('.search-plus-popover-input')!, 'ArrowDown');
    key(q<HTMLButtonElement>('.search-plus-add-filter')!, 'j', { ctrlKey: true });
    expect(hostListener).not.toHaveBeenCalled();
    activeDocument.body.removeEventListener('keydown', hostListener);
  });

  it('renders a bounded number of values for huge properties', () => {
    ctx.bar.destroy();
    const many: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 5000; i++) many[`n${i}.md`] = { id: `v${i}` };
    ctx = setup(many);
    ctx.store.addRow('id');
    q<HTMLButtonElement>('.search-plus-filter-value')!.click();
    expect(popAll('.search-plus-popover-item').length).toBeLessThanOrEqual(51);
    expect(pop('.search-plus-popover-more')!.textContent).toMatch(/4950 more/);
    type(pop<HTMLInputElement>('.search-plus-popover-input')!, 'v4999');
    expect(popAll('.search-plus-popover-label').map((el) => el.textContent)).toContain('v4999');
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

describe('FilterBar popover placement', () => {
  const rect = (top: number, left: number, width = 100, height = 24) =>
    ({ top, left, width, height, bottom: top + height, right: left + width }) as DOMRect;

  function placement() {
    const el = activeDocument.querySelector<HTMLElement>('.search-plus-floating-popover')!;
    const v = (name: string) => el.style.getPropertyValue(`--search-plus-popover-${name}`);
    return {
      el,
      left: parseFloat(v('left')),
      width: parseFloat(v('width')),
      top: v('top'),
      bottom: v('bottom'),
      maxHeight: parseFloat(v('max-height')),
    };
  }

  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(400);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(600);
    ctx = setup(files);
  });
  afterEach(() => {
    ctx.bar.destroy();
    ctx.host.remove();
    vi.restoreAllMocks();
  });

  it('opens below the anchor with a bounded height', () => {
    const button = ctx.host.querySelector<HTMLButtonElement>('.search-plus-add-filter')!;
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(rect(40, 20));
    button.click();
    const p = placement();
    expect(p.top).toBe('68px');
    expect(p.bottom).toBe('auto');
    expect(p.maxHeight).toBeLessThanOrEqual(360);
  });

  it('opens above the anchor near the bottom edge', () => {
    const button = ctx.host.querySelector<HTMLButtonElement>('.search-plus-add-filter')!;
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(rect(560, 20));
    button.click();
    const p = placement();
    expect(p.el.classList.contains('is-above')).toBe(true);
    expect(p.top).toBe('auto');
    expect(p.bottom).toBe(`${600 - 560 + 4}px`);
    expect(p.maxHeight).toBeLessThanOrEqual(560);
  });

  it('stays inside the viewport near the right edge and in narrow windows', () => {
    const button = ctx.host.querySelector<HTMLButtonElement>('.search-plus-add-filter')!;
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(rect(40, 380, 20));
    button.click();
    let p = placement();
    expect(p.left + p.width).toBeLessThanOrEqual(400 - 8);
    expect(p.left).toBeGreaterThanOrEqual(8);
    ctx.bar.closePopover();

    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(220);
    button.click();
    p = placement();
    expect(p.width).toBeLessThanOrEqual(220 - 16);
    expect(p.left).toBe(8);
  });

  it('follows its anchor on window resize', () => {
    const button = ctx.host.querySelector<HTMLButtonElement>('.search-plus-add-filter')!;
    const spy = vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(rect(40, 20));
    button.click();
    spy.mockReturnValue(rect(100, 20));
    window.dispatchEvent(new Event('resize'));
    expect(placement().top).toBe('128px');
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
    expect(handleKey(scope, arrow)).toBe(true);
    expect(arrow.defaultPrevented).toBe(false);

    // Escape with an open popover closes the popover, not the modal.
    ctx.bar.openPicker();
    handleKey(scope, new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(ctx.bar.isPopoverOpen()).toBe(false);
    expect(ctx.onEscape).not.toHaveBeenCalled();

    // Escape without an open popover closes the modal.
    button.focus();
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    const scope2 = scopes(ctx.app)[0]!;
    handleKey(scope2, new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(ctx.onEscape).toHaveBeenCalledTimes(1);
    ctx.bar.destroy();
    expect(scopes(ctx.app)).toHaveLength(0);
    ctx.host.remove();
  });

  it('keeps the scope while focus is in the body-level popover', () => {
    const ctx = setup(files, true);
    ctx.bar.openPicker();
    const input = pop<HTMLInputElement>('.search-plus-popover-input')!;
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(scopes(ctx.app)).toHaveLength(1);
    input.dispatchEvent(
      new FocusEvent('focusout', {
        bubbles: true,
        relatedTarget: ctx.host.querySelector('.search-plus-add-filter'),
      }),
    );
    expect(scopes(ctx.app)).toHaveLength(1);
    ctx.bar.destroy();
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

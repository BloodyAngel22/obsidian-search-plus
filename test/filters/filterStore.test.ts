import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterStore } from '../../src/filters/filterStore';

describe('FilterStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('adds one editable row per property and toggles typed values', () => {
    const store = new FilterStore(undefined, vi.fn());
    const row = store.addRow('projects')!;
    expect(store.addRow('projects')!.id).toBe(row.id);
    store.toggleValue(row.id, 'a');
    store.toggleValue(row.id, 1);
    store.toggleValue(row.id, '1');
    expect(store.getRows()[0]!.values).toEqual(['a', 1, '1']);
    store.toggleValue(row.id, 1);
    expect(store.getRows()[0]!.values).toEqual(['a', '1']);
    store.clearValues(row.id);
    expect(store.getRows()[0]!.values).toEqual([]);
  });

  it('notifies every subscriber with the same new state (shared across views)', () => {
    const store = new FilterStore(undefined, vi.fn());
    const modal = vi.fn();
    const panel = vi.fn();
    store.subscribe(modal);
    const unsubscribe = store.subscribe(panel);
    const row = store.addRow('type')!;
    store.setOperator(row.id, 'EXISTS');
    expect(modal).toHaveBeenCalledTimes(2);
    expect(panel).toHaveBeenCalledTimes(2);
    expect(modal.mock.calls[1]![0]).toBe(panel.mock.calls[1]![0]);
    unsubscribe();
    store.removeRow(row.id);
    expect(panel).toHaveBeenCalledTimes(2);
    expect(modal).toHaveBeenCalledTimes(3);
  });

  it('persists serialisable state, debounced, and flushes on demand', () => {
    const persist = vi.fn();
    const store = new FilterStore(undefined, persist, 300);
    const row = store.addRow('status')!;
    store.toggleValue(row.id, 'done');
    expect(persist).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(persist).toHaveBeenCalledTimes(1);
    const saved = persist.mock.calls[0]![0] as unknown;
    expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
    store.clearAll();
    store.flush();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1]![0]).toEqual({ version: 1, rows: [] });
  });

  it('restores persisted state through normalisation', () => {
    const store = new FilterStore(
      { rows: [{ id: 'x', field: 'type', operator: 'IN', values: ['learn'] }, { field: 5 }] },
      vi.fn(),
    );
    expect(store.getRows()).toEqual([
      { id: 'x', field: 'type', operator: 'IN', values: ['learn'] },
    ]);
  });

  it('does not notify when nothing changed', () => {
    const store = new FilterStore(undefined, vi.fn());
    const listener = vi.fn();
    store.subscribe(listener);
    store.clearAll();
    store.toggleValue('missing', 'x');
    expect(listener).not.toHaveBeenCalled();
  });
});

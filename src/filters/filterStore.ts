import { EMPTY_FILTER_STATE, newRowId, normalizeFilterState, scalarKey } from './filterState';
import {
  FILTER_LIMITS,
  type FilterRow,
  type FilterRowOperator,
  type FilterScalar,
  type MetadataFilterState,
} from './types';

type Listener = (state: MetadataFilterState) => void;

/**
 * The one source of truth for visual metadata filters. SearchModal and SearchPanelView
 * both read and write it, so the two interfaces never disagree, and every change is
 * persisted (debounced) through the plugin settings.
 *
 * State objects are replaced, never mutated, so a listener can compare references.
 */
export class FilterStore {
  private state: MetadataFilterState;
  private listeners = new Set<Listener>();
  private saveTimer: number | undefined;

  constructor(
    initial: unknown,
    private readonly persist: (state: MetadataFilterState) => void | Promise<void>,
    private readonly saveDelayMs = 400,
  ) {
    this.state = normalizeFilterState(initial ?? EMPTY_FILTER_STATE);
  }

  getState(): MetadataFilterState {
    return this.state;
  }

  getRows(): readonly FilterRow[] {
    return this.state.rows;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Adds a row for `field`, or returns the existing one: one editable row per property. */
  addRow(field: string): FilterRow | null {
    const existing = this.state.rows.find((row) => row.field === field);
    if (existing) return existing;
    if (this.state.rows.length >= FILTER_LIMITS.maxConditions) return null;
    const row: FilterRow = { id: newRowId(), field, operator: 'IN', values: [] };
    this.commit([...this.state.rows, row]);
    return row;
  }

  removeRow(id: string): void {
    this.commit(this.state.rows.filter((row) => row.id !== id));
  }

  setOperator(id: string, operator: FilterRowOperator): void {
    this.updateRow(id, (row) => ({ ...row, operator }));
  }

  toggleValue(id: string, value: FilterScalar): void {
    this.updateRow(id, (row) => {
      const key = scalarKey(value);
      const has = row.values.some((v) => scalarKey(v) === key);
      if (has) return { ...row, values: row.values.filter((v) => scalarKey(v) !== key) };
      if (row.values.length >= FILTER_LIMITS.maxValues) return row;
      return { ...row, values: [...row.values, value] };
    });
  }

  clearValues(id: string): void {
    this.updateRow(id, (row) => ({ ...row, values: [] }));
  }

  clearAll(): void {
    if (this.state.rows.length === 0) return;
    this.commit([]);
  }

  /** Writes any pending change immediately (used on unload). */
  flush(): void {
    if (this.saveTimer === undefined) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    void this.persist(this.state);
  }

  private updateRow(id: string, update: (row: FilterRow) => FilterRow): void {
    let changed = false;
    const rows = this.state.rows.map((row) => {
      if (row.id !== id) return row;
      const next = update(row);
      if (next !== row) changed = true;
      return next;
    });
    if (changed) this.commit(rows);
  }

  private commit(rows: FilterRow[]): void {
    this.state = { version: 1, rows };
    for (const listener of [...this.listeners]) {
      try {
        listener(this.state);
      } catch (error) {
        console.error('Search Plus: filter listener failed.', error);
      }
    }
    if (this.saveTimer !== undefined) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = undefined;
      void this.persist(this.state);
    }, this.saveDelayMs);
  }
}

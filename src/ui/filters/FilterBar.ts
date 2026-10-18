import { Scope, setIcon, type App } from 'obsidian';
import {
  formatScalar,
  operatorNeedsValues,
  scalarTypeLabel,
  validateRow,
} from '../../filters/filterState';
import type { FilterStore } from '../../filters/filterStore';
import type { MetadataCatalog } from '../../filters/metadataCatalog';
import type { MetadataMenuAdapter, MetadataMenuHint } from '../../filters/metadataMenu';
import { FILTER_ROW_OPERATORS, type FilterRow, type FilterRowOperator } from '../../filters/types';
import { handledListEvents, SearchableList } from './SearchableList';
import { buildPropertyPage, buildValuePage, type ValuePage } from './valueItems';

type SearchMode = 'hybrid' | 'semantic' | 'fulltext' | 'title';

const MODE_LABELS: Record<SearchMode, string> = {
  hybrid: 'Hybrid',
  semantic: 'Semantic',
  fulltext: 'Full-text',
  title: 'Title',
};

export type FilterStatusTone = 'normal' | 'muted' | 'warning' | 'error';

export interface FilterBarOptions {
  app: App;
  store: FilterStore;
  catalog: MetadataCatalog;
  metadataMenu?: MetadataMenuAdapter;
  /** Shows the mode dropdown when given. */
  mode?: { get: () => SearchMode; set: (mode: SearchMode) => void };
  /**
   * Keyboard isolation for hosts with their own key scope (the search modal): while
   * focus is inside the bar a child scope is pushed, so arrows and Enter never move or
   * open search results, and Escape closes an open list before the modal.
   */
  keyScope?: { parent: Scope | undefined; onEscape: () => void };
  /** Return focus to the host's search input. */
  focusSearch?: () => void;
}

type OpenPopover = { kind: 'picker' } | { kind: 'values'; rowId: string };

/**
 * Compact metadata filter UI shared by SearchModal and SearchPanelView. All state
 * lives in the FilterStore; this component only renders it and turns user actions
 * into store updates, so both views behave identically.
 */
export class FilterBar {
  readonly el: HTMLDivElement;
  private modeSelect?: HTMLSelectElement;
  private addButton: HTMLButtonElement;
  private popoverHost: HTMLDivElement;
  private rowsEl: HTMLDivElement;
  private footerEl: HTMLDivElement;
  private statusEl: HTMLSpanElement;
  private clearButton: HTMLButtonElement;
  private actionButton: HTMLButtonElement;
  private actionHandler: (() => void) | null = null;
  private rendering = false;
  private open: OpenPopover | null = null;
  private list: SearchableList | null = null;
  /** Which popover `list` belongs to, so state is only restored into the same one. */
  private listOwner: string | null = null;
  private valuePage: ValuePage | null = null;
  private hints = new Map<string, MetadataMenuHint>();
  private scope: Scope | null = null;
  private scopePushed = false;
  private disposers: Array<() => void> = [];

  constructor(
    parent: HTMLElement,
    private readonly options: FilterBarOptions,
  ) {
    this.el = parent.createDiv({ cls: 'search-plus-filter-bar' });
    const toolbar = this.el.createDiv({ cls: 'search-plus-filter-toolbar' });
    if (options.mode) {
      this.modeSelect = toolbar.createEl('select', {
        cls: 'dropdown search-plus-mode-select',
        attr: { 'aria-label': 'Search mode' },
      });
      for (const [value, label] of Object.entries(MODE_LABELS)) {
        this.modeSelect.createEl('option', { text: label, attr: { value } });
      }
      this.modeSelect.value = options.mode.get();
      this.modeSelect.addEventListener('change', () => {
        options.mode?.set(this.modeSelect!.value as SearchMode);
      });
    }
    toolbar.createDiv({ cls: 'search-plus-toolbar-spacer' });
    this.addButton = toolbar.createEl('button', {
      cls: 'search-plus-add-filter',
      attr: { type: 'button', 'aria-label': 'Add filter', 'aria-haspopup': 'listbox' },
    });
    setIcon(this.addButton.createSpan({ cls: 'search-plus-add-icon' }), 'plus');
    this.addButton.createSpan({ text: 'Filter' });
    this.addButton.addEventListener('click', () => this.togglePicker());

    this.popoverHost = this.el.createDiv({ cls: 'search-plus-popover-host' });
    this.rowsEl = this.el.createDiv({ cls: 'search-plus-filter-rows' });
    this.footerEl = this.el.createDiv({ cls: 'search-plus-filter-footer' });
    this.clearButton = this.footerEl.createEl('button', {
      cls: 'search-plus-clear-filters mod-muted',
      text: 'Clear filters',
      attr: { type: 'button' },
    });
    this.clearButton.addEventListener('click', () => {
      this.closePopover();
      options.store.clearAll();
      options.focusSearch?.();
    });
    this.statusEl = this.footerEl.createSpan({
      cls: 'search-plus-filter-status',
      attr: { 'aria-live': 'polite' },
    });
    this.actionButton = this.footerEl.createEl('button', {
      cls: 'search-plus-footer-action mod-muted',
      attr: { type: 'button' },
    });
    this.actionButton.hide();
    this.actionButton.addEventListener('click', () => this.actionHandler?.());

    // Keys typed inside the bar belong to the bar: the panel's result navigation
    // listens on an ancestor and must not see them.
    this.el.addEventListener('keydown', (evt) => evt.stopPropagation());
    // A popover never stays open without focus, so Escape in the search input keeps
    // its usual meaning. Re-renders move focus internally and are ignored.
    this.el.addEventListener('focusout', (evt) => {
      if (this.rendering) return;
      const next = evt.relatedTarget as Node | null;
      if (next && this.el.contains(next)) return;
      if (this.open) this.closePopover();
    });
    if (options.keyScope) this.setupKeyScope(options.keyScope);

    this.disposers.push(options.store.subscribe(() => this.render()));
    this.disposers.push(options.catalog.onChange(() => this.render()));
    this.render();
  }

  setMode(mode: SearchMode): void {
    if (this.modeSelect) this.modeSelect.value = mode;
  }

  setStatus(text: string, tone: FilterStatusTone = 'normal'): void {
    this.statusEl.textContent = text;
    this.statusEl.dataset.tone = tone;
    this.updateFooterVisibility();
  }

  /** A host-defined button next to the status, e.g. "Load more". Null hides it. */
  setFooterAction(label: string | null, handler?: () => void): void {
    this.actionHandler = label ? (handler ?? null) : null;
    this.actionButton.textContent = label ?? '';
    this.actionButton.toggle(!!label);
    this.updateFooterVisibility();
  }

  isPopoverOpen(): boolean {
    return this.open !== null;
  }

  /** Closes an open picker or value list; returns false when nothing was open. */
  closePopover(): boolean {
    if (!this.open) return false;
    this.open = null;
    this.list = null;
    this.valuePage = null;
    this.render();
    return true;
  }

  openPicker(): void {
    this.open = { kind: 'picker' };
    this.render();
    this.list?.focus();
  }

  destroy(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.popScope();
    this.el.remove();
  }

  private togglePicker(): void {
    if (this.open?.kind === 'picker') {
      this.closePopover();
      this.options.focusSearch?.();
    } else {
      this.openPicker();
    }
  }

  private openValues(rowId: string): void {
    this.open = { kind: 'values', rowId };
    this.render();
    this.list?.focus();
  }

  private render(): void {
    this.rendering = true;
    try {
      this.renderContent();
    } finally {
      this.rendering = false;
    }
    // The focused control may have been removed; never keep keys captured then.
    const active = this.el.ownerDocument.activeElement;
    if (this.scopePushed && !(active && this.el.contains(active))) this.popScope();
  }

  private renderContent(): void {
    const rows = this.options.store.getRows();
    // A re-render replaces the list; keep its query, highlight and focus.
    const hadFocus =
      this.list !== null && this.el.ownerDocument.activeElement === this.list.inputEl;
    const sameOwner = this.listOwner !== null && this.listOwner === this.ownerKey(this.open);
    const previousQuery = sameOwner ? (this.list?.getQuery() ?? '') : '';
    const previousActive = sameOwner ? (this.list?.getActiveIndex() ?? 0) : 0;
    if (
      this.open?.kind === 'values' &&
      !rows.some((row) => row.id === (this.open as { rowId: string }).rowId)
    ) {
      this.open = null;
    }

    this.addButton.toggleClass('is-active', this.open?.kind === 'picker');
    this.addButton.setAttribute('aria-expanded', this.open?.kind === 'picker' ? 'true' : 'false');
    this.popoverHost.empty();
    this.list = null;
    this.listOwner = this.ownerKey(this.open);
    if (this.open?.kind === 'picker') {
      this.renderPicker(previousQuery, previousActive);
    }

    this.rowsEl.empty();
    for (const row of rows) this.renderRow(row, previousQuery, previousActive);
    this.el.toggleClass('has-filters', rows.length > 0);
    this.updateFooterVisibility();
    // renderPicker / renderRow may have created a new list.
    if (hadFocus) (this.list as SearchableList | null)?.focus();
  }

  private ownerKey(open: OpenPopover | null): string | null {
    if (!open) return null;
    return open.kind === 'picker' ? 'picker' : `values:${open.rowId}`;
  }

  private updateFooterVisibility(): void {
    const hasRows = this.options.store.getRows().length > 0;
    this.clearButton.toggle(hasRows);
    this.footerEl.toggle(hasRows || !!this.statusEl.textContent || !!this.actionHandler);
  }

  private renderPicker(query: string, active: number): void {
    const activeFields = new Set(this.options.store.getRows().map((row) => row.field));
    const { state } = this.options.catalog.getState();
    this.list = new SearchableList(this.popoverHost, {
      placeholder: 'Find a property...',
      emptyText: state === 'scanning' ? 'Reading properties...' : 'No properties found.',
      ariaLabel: 'Find a property',
      initialQuery: query,
      initialActive: active,
      load: (q) => buildPropertyPage(this.options.catalog, q, activeFields),
      onChoose: (item) => {
        const field = item.id.slice(2);
        const row = this.options.store.addRow(field);
        if (!row) {
          this.setStatus('Too many filters.', 'warning');
          return;
        }
        if (operatorNeedsValues(row.operator)) this.openValues(row.id);
        else this.closePopover();
      },
      onClose: () => {
        this.closePopover();
        this.options.focusSearch?.();
      },
    });
  }

  private renderRow(row: FilterRow, query: string, active: number): void {
    const validation = validateRow(row);
    const noMatch = this.noMatchReason(row);
    const rowEl = this.rowsEl.createDiv({
      cls: `search-plus-filter-row is-${validation.status}${noMatch ? ' has-no-match' : ''}`,
      attr: { 'data-row-id': row.id, 'data-field': row.field },
    });
    const head = rowEl.createDiv({ cls: 'search-plus-filter-row-head' });
    const property = this.options.catalog.getProperty(row.field);
    head.createSpan({
      cls: 'search-plus-filter-field',
      text: row.field,
      attr: {
        title: property?.caseVariants.length
          ? `${row.field} (also used as ${property.caseVariants.join(', ')})`
          : row.field,
      },
    });

    const operatorSelect = head.createEl('select', {
      cls: 'dropdown search-plus-operator-select',
      attr: { 'aria-label': `Condition for ${row.field}` },
    });
    for (const { value, label } of FILTER_ROW_OPERATORS) {
      operatorSelect.createEl('option', { text: label, attr: { value } });
    }
    operatorSelect.value = row.operator;
    operatorSelect.addEventListener('change', () => {
      this.options.store.setOperator(row.id, operatorSelect.value as FilterRowOperator);
    });

    const removeButton = head.createEl('button', {
      cls: 'clickable-icon search-plus-remove-filter',
      attr: { type: 'button', 'aria-label': `Remove ${row.field} filter` },
    });
    setIcon(removeButton, 'x');
    removeButton.addEventListener('click', () => {
      this.options.store.removeRow(row.id);
      this.options.focusSearch?.();
    });

    if (operatorNeedsValues(row.operator)) this.renderValues(rowEl, row);

    const message = validation.status !== 'active' ? validation.message : noMatch;
    if (message) rowEl.createDiv({ cls: 'search-plus-filter-message', text: message });

    if (this.open?.kind === 'values' && this.open.rowId === row.id) {
      const host = rowEl.createDiv({ cls: 'search-plus-row-popover' });
      this.renderValueList(host, row, query, active);
    }
  }

  private renderValues(rowEl: HTMLElement, row: FilterRow): void {
    const valuesEl = rowEl.createDiv({ cls: 'search-plus-filter-values' });
    for (const value of row.values) {
      const missing = this.options.catalog.valueCount(row.field, value) === 0;
      const chip = valuesEl.createSpan({
        cls: `search-plus-chip${missing ? ' is-missing' : ''}`,
        attr: missing ? { title: 'No note has this value now' } : {},
      });
      chip.createSpan({ cls: 'search-plus-chip-label', text: formatScalar(value) });
      const type = scalarTypeLabel(value);
      if (type) chip.createSpan({ cls: 'search-plus-type-badge', text: type });
      const remove = chip.createEl('button', {
        cls: 'search-plus-chip-remove',
        text: '×',
        attr: { type: 'button', 'aria-label': `Remove value ${formatScalar(value)}` },
      });
      remove.addEventListener('click', () => this.options.store.toggleValue(row.id, value));
    }
    const addValue = valuesEl.createEl('button', {
      cls: 'search-plus-add-value',
      text: row.values.length === 0 ? 'Select value' : '+',
      attr: { type: 'button', 'aria-label': `Select values for ${row.field}` },
    });
    addValue.addEventListener('click', () => {
      if (this.open?.kind === 'values' && this.open.rowId === row.id) this.closePopover();
      else this.openValues(row.id);
    });
    if (row.values.length > 1) {
      const clear = valuesEl.createEl('button', {
        cls: 'search-plus-clear-values mod-muted',
        text: 'Clear',
        attr: { type: 'button', 'aria-label': `Clear values of ${row.field}` },
      });
      clear.addEventListener('click', () => this.options.store.clearValues(row.id));
    }
  }

  private renderValueList(host: HTMLElement, row: FilterRow, query: string, active: number): void {
    const hint = this.getHint(row.field);
    this.list = new SearchableList(host, {
      placeholder: `Find ${row.field} values...`,
      emptyText: 'No values yet. Type a value to use it.',
      ariaLabel: `Values of ${row.field}`,
      keepOpenOnChoose: true,
      initialQuery: query,
      initialActive: active,
      load: (q) => {
        const current = this.options.store.getRows().find((r) => r.id === row.id) ?? row;
        this.valuePage = buildValuePage(this.options.catalog, current, q, hint);
        return this.valuePage;
      },
      onChoose: (item) => {
        const value = this.valuePage?.valueById.get(item.id);
        if (value === undefined) return;
        this.options.store.toggleValue(row.id, value);
      },
      onClose: () => {
        this.closePopover();
        const rowEl = Array.from(this.rowsEl.children).find(
          (el) => (el as HTMLElement).dataset.rowId === row.id,
        );
        rowEl?.querySelector<HTMLElement>('.search-plus-add-value')?.focus();
      },
    });
  }

  /** Client-side hint from the catalog; the engine still decides the real matches. */
  private noMatchReason(row: FilterRow): string | undefined {
    const property = this.options.catalog.getProperty(row.field);
    if (row.operator === 'MISSING') return undefined;
    if (!property) {
      return this.options.catalog.getState().state === 'ready'
        ? 'No note has this property now.'
        : undefined;
    }
    if (row.operator === 'IN' && row.values.length > 0) {
      const any = row.values.some((v) => this.options.catalog.valueCount(row.field, v) > 0);
      if (!any) return 'No note has these values now.';
    }
    return undefined;
  }

  private getHint(field: string): MetadataMenuHint | null {
    const adapter = this.options.metadataMenu;
    if (!adapter?.isAvailable()) return null;
    const known = this.hints.get(field);
    if (known) return known;
    void adapter
      .getHint(field, this.options.catalog.samplePathsWithField(field, 5))
      .then((hint) => {
        this.hints.set(field, hint);
        if (hint.options.length > 0 && this.open?.kind === 'values') this.render();
      })
      .catch(() => {});
    return null;
  }

  private setupKeyScope(config: NonNullable<FilterBarOptions['keyScope']>): void {
    const scope = new Scope(config.parent);
    // Returning true marks the key as handled by this scope WITHOUT preventDefault,
    // so native controls (selects, buttons, the list input) keep working while the
    // modal's own handlers for these keys never run.
    const passThrough = () => true;
    scope.register([], 'ArrowUp', passThrough);
    scope.register([], 'ArrowDown', passThrough);
    scope.register([], 'Enter', passThrough);
    scope.register(['Mod'], 'Enter', passThrough);
    scope.register(['Mod'], 'j', passThrough);
    scope.register(['Mod'], 'k', passThrough);
    scope.register(['Mod'], 'o', passThrough);
    scope.register(['Alt'], 'Enter', passThrough);
    // Always consumes Escape (false = handled + preventDefault in Obsidian scopes).
    // eslint-disable-next-line sonarjs/no-invariant-returns -- see above
    scope.register([], 'Escape', (evt: KeyboardEvent) => {
      if (handledListEvents.has(evt) || this.closePopover()) {
        this.options.focusSearch?.();
        return false;
      }
      config.onEscape();
      return false;
    });
    this.scope = scope;
    const onFocusIn = () => this.pushScope();
    const onFocusOut = (evt: FocusEvent) => {
      if (this.rendering) return;
      const next = evt.relatedTarget as Node | null;
      if (next && this.el.contains(next)) return;
      this.popScope();
    };
    this.el.addEventListener('focusin', onFocusIn);
    this.el.addEventListener('focusout', onFocusOut);
  }

  private pushScope(): void {
    if (!this.scope || this.scopePushed) return;
    this.options.app.keymap?.pushScope(this.scope);
    this.scopePushed = true;
  }

  private popScope(): void {
    if (!this.scope || !this.scopePushed) return;
    this.options.app.keymap?.popScope(this.scope);
    this.scopePushed = false;
  }
}

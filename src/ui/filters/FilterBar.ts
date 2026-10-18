import { Scope, setIcon, type App } from 'obsidian';
import {
  formatScalar,
  operatorNeedsValues,
  scalarKey,
  scalarTypeLabel,
  validateRow,
} from '../../filters/filterState';
import type { FilterStore } from '../../filters/filterStore';
import type { MetadataCatalog } from '../../filters/metadataCatalog';
import type { MetadataMenuAdapter, MetadataMenuHint } from '../../filters/metadataMenu';
import { FILTER_ROW_OPERATORS, type FilterRow, type FilterRowOperator } from '../../filters/types';
import { FloatingPopover } from './FloatingPopover';
import { handledListEvents, SearchableList } from './SearchableList';
import { buildPropertyPage, buildValuePage, type ValuePage } from './valueItems';

type SearchMode = 'hybrid' | 'semantic' | 'fulltext' | 'title';

const MODE_LABELS: Record<SearchMode, string> = {
  hybrid: 'Hybrid',
  semantic: 'Semantic',
  fulltext: 'Full-text',
  title: 'Title',
};

/** Up to this many values are named in the row; more are shown as a count. */
const NAMED_VALUES = 2;

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
   * focus is inside the bar or its popover a child scope is pushed, so arrows and Enter
   * never move or open search results, and Escape closes an open popover before the modal.
   */
  keyScope?: { parent: Scope | undefined; onEscape: () => void };
  /** Return focus to the host's search input. */
  focusSearch?: () => void;
}

/** DOM of one filter row, built once and updated in place. */
interface RowView {
  el: HTMLDivElement;
  stateEl: HTMLSpanElement;
  fieldEl: HTMLSpanElement;
  operatorSelect: HTMLSelectElement;
  valueButton: HTMLButtonElement;
  messageEl: HTMLDivElement;
  /** What the row was last rendered from; unchanged rows are not touched. */
  signature: string;
}

type OpenPopover =
  | { kind: 'picker'; popover: FloatingPopover; list: SearchableList }
  | {
      kind: 'values';
      rowId: string;
      popover: FloatingPopover;
      list: SearchableList;
      headerEl: HTMLDivElement;
    };

/**
 * Compact metadata filter UI shared by SearchModal and SearchPanelView: a toolbar
 * (mode, "+ Filter"), one single-line row per filter and a floating popover for picking
 * properties and values. All state lives in the FilterStore; this component renders it
 * and turns user actions into store updates, so both views behave identically.
 */
export class FilterBar {
  readonly el: HTMLDivElement;
  private modeSelect?: HTMLSelectElement;
  private addButton: HTMLButtonElement;
  private clearButton: HTMLButtonElement;
  private rowsEl: HTMLDivElement;
  private footerEl: HTMLDivElement;
  private statusEl: HTMLSpanElement;
  private actionButton: HTMLButtonElement;
  private actionHandler: (() => void) | null = null;
  private rowViews = new Map<string, RowView>();
  private open: OpenPopover | null = null;
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
    this.clearButton = toolbar.createEl('button', {
      cls: 'search-plus-clear-filters clickable-icon',
      text: 'Clear',
      attr: { type: 'button', 'aria-label': 'Clear all filters' },
    });
    this.clearButton.addEventListener('click', () => {
      this.closePopover();
      options.store.clearAll();
      options.focusSearch?.();
    });
    this.addButton = toolbar.createEl('button', {
      cls: 'search-plus-add-filter',
      attr: { type: 'button', 'aria-label': 'Add filter', 'aria-haspopup': 'listbox' },
    });
    setIcon(this.addButton.createSpan({ cls: 'search-plus-add-icon' }), 'plus');
    this.addButton.createSpan({ text: 'Filter' });
    this.addButton.addEventListener('click', () => this.togglePicker());

    this.rowsEl = this.el.createDiv({ cls: 'search-plus-filter-rows' });
    this.footerEl = this.el.createDiv({ cls: 'search-plus-filter-footer' });
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
    // its usual meaning.
    this.el.addEventListener('focusout', (evt) => this.onFocusOut(evt));
    if (options.keyScope) this.setupKeyScope(options.keyScope);

    this.disposers.push(options.store.subscribe(() => this.update()));
    this.disposers.push(options.catalog.onChange(() => this.update(true)));
    this.update();
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

  /**
   * Closes an open picker or value list; returns false when nothing was open. With
   * `restoreFocus` the control that opened the popover gets focus back.
   */
  closePopover(restoreFocus = false): boolean {
    const open = this.open;
    if (!open) return false;
    this.open = null;
    this.valuePage = null;
    const trigger = this.triggerOf(open);
    const hadFocus = this.isInside(open.popover.el.ownerDocument.activeElement);
    open.popover.destroy();
    this.addButton.removeClass('is-active');
    this.addButton.setAttribute('aria-expanded', 'false');
    for (const view of this.rowViews.values()) {
      view.valueButton.setAttribute('aria-expanded', 'false');
      view.el.removeClass('is-editing');
    }
    if (restoreFocus && trigger?.isConnected) trigger.focus();
    else if (hadFocus && !this.isInside(this.el.ownerDocument.activeElement)) this.popScope();
    return true;
  }

  openPicker(): void {
    this.closePopover();
    const activeFields = new Set(this.options.store.getRows().map((row) => row.field));
    const popover = this.createPopover(this.addButton, 'search-plus-picker-popover');
    const { state } = this.options.catalog.getState();
    const list = new SearchableList(popover.el, {
      placeholder: 'Find a property...',
      emptyText: state === 'scanning' ? 'Reading properties...' : 'No properties found.',
      ariaLabel: 'Find a property',
      load: (q) => {
        activeFields.clear();
        for (const row of this.options.store.getRows()) activeFields.add(row.field);
        return buildPropertyPage(this.options.catalog, q, activeFields);
      },
      onChoose: (item) => {
        const field = item.id.slice(2);
        const row = this.options.store.addRow(field);
        if (!row) {
          this.setStatus('Too many filters.', 'warning');
          return;
        }
        if (operatorNeedsValues(row.operator)) this.openValues(row.id);
        else this.closePopover(true);
      },
      onClose: () => this.closePopover(true),
    });
    this.open = { kind: 'picker', popover, list };
    this.addButton.addClass('is-active');
    this.addButton.setAttribute('aria-expanded', 'true');
    list.focus();
  }

  destroy(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.closePopover();
    this.popScope();
    this.el.remove();
  }

  private togglePicker(): void {
    if (this.open?.kind === 'picker') this.closePopover(true);
    else this.openPicker();
  }

  private openValues(rowId: string): void {
    const view = this.rowViews.get(rowId);
    const row = this.options.store.getRows().find((r) => r.id === rowId);
    if (!view || !row) return;
    this.closePopover();
    const popover = this.createPopover(view.valueButton, 'search-plus-row-popover');
    const headerEl = popover.el.createDiv({ cls: 'search-plus-popover-header' });
    // Clicking header text must not take focus away from the search input.
    headerEl.addEventListener('mousedown', (evt) => {
      if (!(evt.target as HTMLElement).closest('button')) evt.preventDefault();
    });
    this.getHint(row.field);
    const list = new SearchableList(popover.el, {
      placeholder: `Find ${row.field} values...`,
      emptyText: 'No values yet. Type a value to use it.',
      ariaLabel: `Values of ${row.field}`,
      keepOpenOnChoose: true,
      load: (q) => {
        const current = this.findRow(rowId) ?? row;
        const hint = this.hints.get(row.field) ?? null;
        this.valuePage = buildValuePage(this.options.catalog, current, q, hint);
        return this.valuePage;
      },
      onChoose: (item) => {
        const value = this.valuePage?.valueById.get(item.id);
        if (value === undefined) return;
        this.options.store.toggleValue(rowId, value);
      },
      onClose: () => this.closePopover(true),
    });
    this.open = { kind: 'values', rowId, popover, list, headerEl };
    this.renderValueHeader();
    view.valueButton.setAttribute('aria-expanded', 'true');
    view.el.addClass('is-editing');
    list.focus();
  }

  private createPopover(anchor: HTMLElement, cls: string): FloatingPopover {
    const popover = new FloatingPopover(anchor, {
      cls,
      isInside: (node) => this.el.contains(node),
      // A click elsewhere closes the popover without stealing focus from what was clicked.
      onOutside: () => this.closePopover(),
    });
    popover.el.addEventListener('keydown', (evt) => {
      evt.stopPropagation();
      // The popover sits at the end of the document; Tab would leave focus nowhere.
      if (evt.key === 'Tab') {
        evt.preventDefault();
        this.closePopover(true);
      }
    });
    popover.el.addEventListener('focusout', (evt) => this.onFocusOut(evt));
    if (this.scope) popover.el.addEventListener('focusin', () => this.pushScope());
    return popover;
  }

  private triggerOf(open: OpenPopover): HTMLElement | null {
    if (open.kind === 'picker') return this.addButton;
    return this.rowViews.get(open.rowId)?.valueButton ?? this.addButton;
  }

  private isInside(node: Node | null | undefined): boolean {
    if (!node) return false;
    return this.el.contains(node) || !!this.open?.popover.el.contains(node);
  }

  private onFocusOut(evt: FocusEvent): void {
    const next = evt.relatedTarget as Node | null;
    if (next && this.isInside(next)) return;
    // Focus left the bar: stop capturing keys. A popover is closed by the click-outside
    // check, or here when focus moved to another control.
    this.popScope();
    if (next && this.open) this.closePopover();
  }

  private findRow(rowId: string): FilterRow | undefined {
    return this.options.store.getRows().find((r) => r.id === rowId);
  }

  /** Bring rows and the open popover in line with the store, touching only what changed. */
  private update(force = false): void {
    const rows = this.options.store.getRows();
    const seen = new Set<string>();
    let previous: HTMLElement | null = null;
    for (const row of rows) {
      seen.add(row.id);
      let view = this.rowViews.get(row.id);
      if (!view) {
        view = this.createRowView(row.id);
        this.rowViews.set(row.id, view);
      }
      this.updateRowView(view, row, force);
      const expectedNext: Element | null = previous
        ? previous.nextElementSibling
        : this.rowsEl.firstElementChild;
      if (expectedNext !== view.el) {
        if (previous) previous.after(view.el);
        else this.rowsEl.prepend(view.el);
      }
      previous = view.el;
    }
    for (const [id, view] of this.rowViews) {
      if (seen.has(id)) continue;
      view.el.remove();
      this.rowViews.delete(id);
    }
    this.el.toggleClass('has-filters', rows.length > 0);
    this.clearButton.toggle(rows.length > 0);
    this.updateFooterVisibility();

    const open = this.open;
    if (open?.kind === 'values') {
      const row = this.findRow(open.rowId);
      if (!row || !operatorNeedsValues(row.operator)) {
        // The row went away or no longer takes values; whoever changed it keeps focus.
        this.closePopover();
        return;
      }
      this.renderValueHeader();
      open.list.refresh();
      open.popover.position();
    } else if (open?.kind === 'picker') {
      open.list.refresh();
    }
  }

  private createRowView(rowId: string): RowView {
    const el = this.rowsEl.createDiv({
      cls: 'search-plus-filter-row',
      attr: { 'data-row-id': rowId },
    });
    const stateEl = el.createSpan({
      cls: 'search-plus-filter-state',
      attr: { 'aria-hidden': 'true' },
    });
    const fieldEl = el.createSpan({ cls: 'search-plus-filter-field' });
    const operatorSelect = el.createEl('select', { cls: 'dropdown search-plus-operator-select' });
    for (const { value, label } of FILTER_ROW_OPERATORS) {
      operatorSelect.createEl('option', { text: label, attr: { value } });
    }
    operatorSelect.addEventListener('change', () => {
      this.options.store.setOperator(rowId, operatorSelect.value as FilterRowOperator);
    });
    const valueButton = el.createEl('button', {
      cls: 'search-plus-filter-value search-plus-add-value',
      attr: { type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' },
    });
    valueButton.addEventListener('click', () => {
      if (this.open?.kind === 'values' && this.open.rowId === rowId) this.closePopover(true);
      else this.openValues(rowId);
    });
    const removeButton = el.createEl('button', {
      cls: 'clickable-icon search-plus-remove-filter',
      attr: { type: 'button' },
    });
    setIcon(removeButton, 'x');
    removeButton.addEventListener('click', () => {
      this.options.store.removeRow(rowId);
      this.options.focusSearch?.();
    });
    const messageEl = el.createDiv({ cls: 'search-plus-filter-message' });
    return { el, stateEl, fieldEl, operatorSelect, valueButton, messageEl, signature: '' };
  }

  private updateRowView(view: RowView, row: FilterRow, force: boolean): void {
    const validation = validateRow(row);
    const noMatch = this.noMatchReason(row);
    const property = this.options.catalog.getProperty(row.field);
    const missing = row.values.filter((v) => this.options.catalog.valueCount(row.field, v) === 0);
    const signature = JSON.stringify([
      row.field,
      row.operator,
      row.values.map(scalarKey),
      validation.status,
      validation.status === 'active' ? '' : validation.message,
      noMatch ?? '',
      missing.map(scalarKey),
      property?.caseVariants ?? [],
    ]);
    if (!force && signature === view.signature) return;
    view.signature = signature;

    const status = validation.status;
    view.el.className = `search-plus-filter-row is-${status}${noMatch ? ' has-no-match' : ''}${
      this.open?.kind === 'values' && this.open.rowId === row.id ? ' is-editing' : ''
    }`;
    view.el.dataset.field = row.field;
    const message = status !== 'active' ? validation.message : noMatch;
    const stateLabel = message ?? 'Filter is active';
    view.stateEl.setAttribute('title', stateLabel);
    view.el.setAttribute('title', message ?? '');

    view.fieldEl.textContent = row.field;
    view.fieldEl.setAttribute(
      'title',
      property?.caseVariants.length
        ? `${row.field} (also used as ${property.caseVariants.join(', ')})`
        : row.field,
    );

    view.operatorSelect.value = row.operator;
    view.operatorSelect.setAttribute('aria-label', `Condition for ${row.field}`);

    const needsValues = operatorNeedsValues(row.operator);
    view.valueButton.toggle(needsValues);
    view.valueButton.setAttribute('aria-label', `Select values for ${row.field}`);
    view.valueButton.toggleClass('is-empty', row.values.length === 0);
    view.valueButton.toggleClass('has-missing', missing.length > 0);
    if (needsValues) {
      const names = row.values.map(formatScalar);
      view.valueButton.textContent = valueSummary(names);
      view.valueButton.setAttribute('title', names.length > 0 ? names.join(', ') : 'Select values');
    }

    // Only blocking problems get a visible line; warnings live in the tooltip and color.
    const visibleMessage = status === 'invalid' ? (validation.message ?? '') : '';
    view.messageEl.textContent = visibleMessage;
    view.messageEl.toggle(visibleMessage !== '');

    const removeButton = view.el.querySelector('.search-plus-remove-filter');
    removeButton?.setAttribute('aria-label', `Remove ${row.field} filter`);
  }

  /** Selected values of the open value popover, each removable, plus "Clear". */
  private renderValueHeader(): void {
    const open = this.open;
    if (open?.kind !== 'values') return;
    const row = this.findRow(open.rowId);
    const header = open.headerEl;
    header.empty();
    if (!row) return;
    const top = header.createDiv({ cls: 'search-plus-popover-summary' });
    top.createSpan({
      cls: 'search-plus-popover-count',
      text: row.values.length === 0 ? 'No value selected' : `${row.values.length} selected`,
    });
    if (row.values.length > 0) {
      const clear = top.createEl('button', {
        cls: 'search-plus-clear-values clickable-icon',
        text: 'Clear',
        attr: { type: 'button', 'aria-label': `Clear values of ${row.field}` },
      });
      clear.addEventListener('click', () => {
        this.options.store.clearValues(row.id);
        open.list.focus();
      });
    }
    if (row.values.length === 0) return;
    const chips = header.createDiv({ cls: 'search-plus-filter-values' });
    for (const value of row.values) {
      const missing = this.options.catalog.valueCount(row.field, value) === 0;
      const chip = chips.createSpan({
        cls: `search-plus-chip${missing ? ' is-missing' : ''}`,
        attr: missing ? { title: 'No note has this value now' } : { title: formatScalar(value) },
      });
      chip.createSpan({ cls: 'search-plus-chip-label', text: formatScalar(value) });
      const type = scalarTypeLabel(value);
      if (type) chip.createSpan({ cls: 'search-plus-type-badge', text: type });
      const remove = chip.createEl('button', {
        cls: 'search-plus-chip-remove',
        text: '×',
        attr: { type: 'button', 'aria-label': `Remove value ${formatScalar(value)}` },
      });
      remove.addEventListener('click', () => {
        this.options.store.toggleValue(row.id, value);
        open.list.focus();
      });
    }
  }

  private updateFooterVisibility(): void {
    this.footerEl.toggle(!!this.statusEl.textContent || !!this.actionHandler);
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
        if (hint.options.length > 0 && this.open?.kind === 'values') this.open.list.refresh();
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
      if (handledListEvents.has(evt)) return false;
      if (this.closePopover(true)) return false;
      config.onEscape();
      return false;
    });
    this.scope = scope;
    this.el.addEventListener('focusin', () => this.pushScope());
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

/** Row text for selected values: "Select value", up to two names, or a count. */
function valueSummary(names: string[]): string {
  if (names.length === 0) return 'Select value';
  if (names.length <= NAMED_VALUES) return names.join(', ');
  return `${names.length} selected`;
}

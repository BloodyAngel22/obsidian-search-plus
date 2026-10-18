export interface ListItem {
  id: string;
  label: string;
  /** Secondary text on the right, e.g. a note count. */
  detail?: string;
  /** Small tag after the label, e.g. a value type. */
  badge?: string;
  checked?: boolean;
  muted?: boolean;
  title?: string;
}

export interface ListPage {
  items: ListItem[];
  /** Matches not rendered because of the render limit. */
  hiddenCount: number;
}

export interface SearchableListOptions {
  placeholder: string;
  emptyText: string;
  /** Items for a query. Must be bounded — the list never renders more than it gets. */
  load: (query: string) => ListPage;
  onChoose: (item: ListItem, query: string) => void;
  /** Called on Escape or when the list asks to close. */
  onClose: () => void;
  /** Keep the list open after choosing (multi-select). */
  keepOpenOnChoose?: boolean;
  ariaLabel: string;
  /** Restores the list after a re-render (query text and highlighted row). */
  initialQuery?: string;
  initialActive?: number;
}

let listCounter = 0;

/** Keyboard events the list consumed. Lets an outer keyboard scope (the search
 *  modal) tell "already handled here" apart from "close the modal". */
export const handledListEvents = new WeakSet<KeyboardEvent>();

/**
 * Inline searchable list: a text input plus a bounded result list, driven entirely by
 * the keyboard (ArrowUp/Down, Enter, Escape) or the mouse. Rendering is capped by the
 * loader, so properties with thousands of values never create thousands of elements.
 */
export class SearchableList {
  readonly el: HTMLDivElement;
  readonly inputEl: HTMLInputElement;
  private listEl: HTMLDivElement;
  private items: ListItem[] = [];
  private active = 0;
  private readonly listId = `search-plus-list-${++listCounter}`;

  constructor(
    parent: HTMLElement,
    private readonly options: SearchableListOptions,
  ) {
    this.el = parent.createDiv({ cls: 'search-plus-popover' });
    this.inputEl = this.el.createEl('input', {
      cls: 'search-plus-popover-input',
      attr: {
        type: 'text',
        placeholder: options.placeholder,
        'aria-label': options.ariaLabel,
        role: 'combobox',
        'aria-expanded': 'true',
        'aria-controls': this.listId,
        spellcheck: 'false',
      },
    });
    this.listEl = this.el.createDiv({
      cls: 'search-plus-popover-list',
      attr: { role: 'listbox', id: this.listId },
    });
    this.inputEl.addEventListener('input', () => {
      this.active = 0;
      this.refresh();
    });
    this.inputEl.addEventListener('keydown', (evt) => this.onKeydown(evt));
    this.listEl.addEventListener('mousedown', (evt) => {
      // Keep focus in the input so the keyboard keeps working after a click.
      evt.preventDefault();
    });
    if (options.initialQuery) this.inputEl.value = options.initialQuery;
    this.active = options.initialActive ?? 0;
    this.refresh();
  }

  getActiveIndex(): number {
    return this.active;
  }

  focus(): void {
    this.inputEl.focus();
  }

  getQuery(): string {
    return this.inputEl.value;
  }

  refresh(): void {
    const page = this.options.load(this.inputEl.value);
    this.items = page.items;
    if (this.active >= this.items.length) this.active = Math.max(0, this.items.length - 1);
    this.listEl.empty();
    if (this.items.length === 0) {
      this.listEl.createDiv({ cls: 'search-plus-popover-empty', text: this.options.emptyText });
    }
    this.items.forEach((item, index) => {
      const row = this.listEl.createDiv({
        cls: `search-plus-popover-item${index === this.active ? ' is-active' : ''}${item.muted ? ' is-muted' : ''}`,
        attr: {
          role: 'option',
          'aria-selected': index === this.active ? 'true' : 'false',
          'data-index': String(index),
          ...(item.checked !== undefined && { 'aria-checked': item.checked ? 'true' : 'false' }),
          ...(item.title && { title: item.title }),
        },
      });
      if (item.checked !== undefined) {
        row.createSpan({ cls: 'search-plus-check', text: item.checked ? '✓' : '' });
      }
      row.createSpan({ cls: 'search-plus-popover-label', text: item.label });
      if (item.badge) row.createSpan({ cls: 'search-plus-type-badge', text: item.badge });
      if (item.detail) row.createSpan({ cls: 'search-plus-popover-detail', text: item.detail });
      row.addEventListener('click', () => this.choose(index));
      row.addEventListener('mousemove', () => this.setActive(index, false));
    });
    if (page.hiddenCount > 0) {
      this.listEl.createDiv({
        cls: 'search-plus-popover-more',
        text: `${page.hiddenCount} more — type to narrow`,
      });
    }
  }

  private setActive(index: number, scroll = true): void {
    if (index === this.active || this.items.length === 0) return;
    const rows = this.listEl.querySelectorAll<HTMLElement>('.search-plus-popover-item');
    rows[this.active]?.classList.remove('is-active');
    rows[this.active]?.setAttribute('aria-selected', 'false');
    this.active = index;
    rows[index]?.classList.add('is-active');
    rows[index]?.setAttribute('aria-selected', 'true');
    if (scroll) rows[index]?.scrollIntoView({ block: 'nearest' });
  }

  private choose(index: number): void {
    const item = this.items[index];
    if (!item) return;
    this.active = index;
    this.options.onChoose(item, this.inputEl.value);
    if (this.options.keepOpenOnChoose) {
      this.refresh();
      this.inputEl.focus();
    }
  }

  private onKeydown(evt: KeyboardEvent): void {
    let handled = true;
    if (evt.key === 'ArrowDown' || (evt.key === 'n' && evt.ctrlKey)) {
      this.setActive(Math.min(this.items.length - 1, this.active + 1));
    } else if (evt.key === 'ArrowUp' || (evt.key === 'p' && evt.ctrlKey)) {
      this.setActive(Math.max(0, this.active - 1));
    } else if (evt.key === 'Enter') {
      this.choose(this.active);
    } else if (evt.key === 'Escape') {
      this.options.onClose();
    } else {
      handled = false;
    }
    if (handled) {
      handledListEvents.add(evt);
      evt.preventDefault();
      evt.stopPropagation();
    }
  }
}

export interface FloatingPopoverOptions {
  cls: string;
  /** Nodes that count as "inside" for click-outside dismissal (the popover itself always does). */
  isInside: (node: Node) => boolean;
  /** Called on a pointer press outside the popover and the inside nodes. */
  onOutside: () => void;
}

const MARGIN = 8;
const GAP = 4;
const MIN_WIDTH = 240;
const MAX_WIDTH = 360;
const MAX_HEIGHT = 360;
const MIN_HEIGHT = 120;
/** Below this much room under the anchor the popover opens above it when that is roomier. */
const PREFERRED_BELOW = 200;

/**
 * A popover that floats above everything at document-body level, anchored to a control.
 * Living outside the modal and the side panel means no ancestor can clip it with
 * `overflow` or trap it in a stacking context; it stays inside the viewport, opens
 * above the anchor near the bottom edge, and has a bounded height.
 */
export class FloatingPopover {
  readonly el: HTMLDivElement;
  private readonly win: Window;
  private readonly reposition = () => this.position();
  private readonly onPointerDown = (evt: Event) => {
    const target = evt.target as Node | null;
    if (!target || this.el.contains(target) || this.options.isInside(target)) return;
    this.options.onOutside();
  };

  constructor(
    private anchor: HTMLElement,
    private readonly options: FloatingPopoverOptions,
  ) {
    const doc = anchor.ownerDocument;
    this.win = doc.defaultView ?? window;
    this.el = doc.body.createDiv({ cls: `search-plus-floating-popover ${options.cls}` });
    this.position();
    this.win.addEventListener('resize', this.reposition);
    // Capture: a scroll in any container (results, sidebar) can move the anchor.
    doc.addEventListener('scroll', this.reposition, true);
    doc.addEventListener('pointerdown', this.onPointerDown, true);
  }

  setAnchor(anchor: HTMLElement): void {
    this.anchor = anchor;
    this.position();
  }

  position(): void {
    const rect = this.anchor.getBoundingClientRect();
    const viewWidth = this.win.innerWidth;
    const viewHeight = this.win.innerHeight;
    const width = Math.max(
      Math.min(MIN_WIDTH, viewWidth - 2 * MARGIN),
      Math.min(Math.max(rect.width, MIN_WIDTH), MAX_WIDTH, viewWidth - 2 * MARGIN),
    );
    const left = Math.min(
      Math.max(rect.left, MARGIN),
      Math.max(MARGIN, viewWidth - MARGIN - width),
    );
    const below = viewHeight - rect.bottom - GAP - MARGIN;
    const above = rect.top - GAP - MARGIN;
    const placeBelow = below >= PREFERRED_BELOW || below >= above;
    const room = placeBelow ? below : above;
    const maxHeight = Math.max(
      Math.min(MIN_HEIGHT, viewHeight - 2 * MARGIN),
      Math.min(MAX_HEIGHT, room),
    );
    this.el.toggleClass('is-above', !placeBelow);
    this.el.setCssProps({
      '--search-plus-popover-left': `${Math.round(left)}px`,
      '--search-plus-popover-width': `${Math.round(width)}px`,
      '--search-plus-popover-max-height': `${Math.round(maxHeight)}px`,
      '--search-plus-popover-top': placeBelow ? `${Math.round(rect.bottom + GAP)}px` : 'auto',
      '--search-plus-popover-bottom': placeBelow
        ? 'auto'
        : `${Math.round(viewHeight - rect.top + GAP)}px`,
    });
  }

  destroy(): void {
    const doc = this.el.ownerDocument;
    this.win.removeEventListener('resize', this.reposition);
    doc.removeEventListener('scroll', this.reposition, true);
    doc.removeEventListener('pointerdown', this.onPointerDown, true);
    this.el.remove();
  }
}

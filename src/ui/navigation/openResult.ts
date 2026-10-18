import {
  MarkdownView,
  type App,
  type EditorPosition,
  type OpenViewState,
  type TFile,
  type WorkspaceLeaf,
} from 'obsidian';
import type { SearchResult } from '../../ipc';
import {
  getPrimaryAnchor,
  normalize,
  resolveAnchorTarget,
  type AnchorTarget,
  type ResolveOptions,
} from './anchorResolver';
import { flashEditorRange } from './editorHighlight';

type SearchMode = 'hybrid' | 'semantic' | 'fulltext' | 'title';

export interface OpenResultOptions {
  /** The mode that produced the result; exact words are highlighted only for text matches. */
  mode?: SearchMode;
  queryWords?: readonly string[];
  /** Passed to `openFile`; leave out to follow the user's preference. */
  active?: boolean;
}

/** How long the Reading view highlight stays. */
const FLASH_MS = 2000;
/** Frames to wait for the opened view to show the file. */
const VIEW_WAIT_STEPS = 30;
const VIEW_WAIT_STEP_MS = 16;
const FLASH_CLASS = 'search-plus-nav-flash';

/**
 * Open a search result in `leaf` and move to its most relevant passage.
 *
 * The leaf is chosen by the caller before anything async happens, and all navigation
 * acts on that leaf's own view — never on whatever view became active meanwhile.
 * Without a verified target (no anchor, stale or ambiguous anchor, metadata-only or
 * title results) the note simply opens.
 */
export async function openResultAtAnchor(
  app: App,
  leaf: WorkspaceLeaf,
  file: TFile,
  result: SearchResult,
  options: OpenResultOptions = {},
): Promise<AnchorTarget | null> {
  const anchor = getPrimaryAnchor(result);
  const resolveOptions: ResolveOptions = {
    queryWords: options.queryWords,
    highlightExact: options.mode !== 'semantic' && options.mode !== 'title',
  };

  let content: string | undefined;
  let target: AnchorTarget | null = null;
  if (anchor) {
    try {
      content = await app.vault.cachedRead(file);
      target = resolveAnchorTarget(content, anchor, resolveOptions);
    } catch {
      target = null;
    }
  }

  const openState: OpenViewState = {};
  if (options.active !== undefined) openState.active = options.active;
  // A collapsed cursor lets Obsidian start at the passage instead of flashing the top
  // first. Not `line`: Obsidian SELECTS the whole line for that state, and may apply it
  // after our own cursor, leaving a selection that the next keystroke would replace.
  if (target && content !== undefined) {
    const at = offsetToEditorPosition(content, target.start);
    openState.eState = { cursor: { from: at, to: at } };
  }
  if (Object.keys(openState).length > 0) await leaf.openFile(file, openState);
  else await leaf.openFile(file);
  if (!anchor) return null;

  const view = await waitForMarkdownView(leaf, file);
  if (!view) return target;
  // Verify again against what the view shows now: the editor can hold unsaved edits.
  const live = readViewData(view) ?? content;
  if (live === undefined) return null;
  const liveTarget = live === content ? target : resolveAnchorTarget(live, anchor, resolveOptions);
  if (!liveTarget) return null;
  if (view.getMode() === 'preview') {
    void revealInReadingView(app, view, live, liveTarget);
  } else {
    revealInEditor(view, live, liveTarget);
  }
  return liveTarget;
}

export function offsetToEditorPosition(content: string, offset: number): EditorPosition {
  let line = 0;
  let lineStart = 0;
  const boundedOffset = Math.max(0, Math.min(offset, content.length));
  for (let index = 0; index < boundedOffset; index++) {
    if (content.charCodeAt(index) === 10) {
      line++;
      lineStart = index + 1;
    }
  }
  return { line, ch: boundedOffset - lineStart };
}

async function waitForMarkdownView(leaf: WorkspaceLeaf, file: TFile): Promise<MarkdownView | null> {
  for (let step = 0; step < VIEW_WAIT_STEPS; step++) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file?.path === file.path) return view;
    await sleep(VIEW_WAIT_STEP_MS);
  }
  return null;
}

function readViewData(view: MarkdownView): string | undefined {
  try {
    const data = view.getViewData();
    return typeof data === 'string' ? data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Source mode and Live Preview: cursor at the target (the exact hit, or the passage
 * start), scrolled to the middle, and a short-lived marker instead of a selection: the
 * exact hit inline, else the verified passage's lines. Nothing is selected, so typing
 * right away never replaces text.
 */
function revealInEditor(view: MarkdownView, content: string, target: AnchorTarget): void {
  const editor = view.editor;
  const from = offsetToEditorPosition(content, target.start);
  const to = offsetToEditorPosition(content, target.end);
  editor.setCursor(from);
  editor.scrollIntoView({ from, to }, true);
  if (target.highlight) {
    flashEditorRange(view, target.highlight.start, target.highlight.end, 'hit', FLASH_MS);
  } else if (target.passage) {
    flashEditorRange(view, target.passage.start, target.passage.end, 'passage', FLASH_MS);
  } else if (target.confidence !== 'chunk' && target.confidence !== 'heading') {
    // An older engine's verified line: mark that line only.
    flashEditorRange(view, target.start, target.end, 'passage', FLASH_MS);
  }
}

/**
 * Reading view: scroll to the target line, then mark the rendered block that holds the
 * anchor text for a moment. The view stays in Reading mode.
 */
async function revealInReadingView(
  app: App,
  view: MarkdownView,
  content: string,
  target: AnchorTarget,
): Promise<void> {
  const line = offsetToEditorPosition(content, target.start).line;
  view.previewMode.applyScroll(line);
  // Reading view renders sections lazily; give it a few frames after the scroll.
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(50);
    if (view.file === null || view.getMode() !== 'preview') return;
    const block = findRenderedBlock(view.previewMode.containerEl, content, target);
    if (block) {
      block.scrollIntoView({ block: 'center' });
      flash(app, block);
      return;
    }
  }
}

const BLOCK_SELECTOR =
  'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, pre, .callout-title-inner';

/**
 * The rendered block for a target, or undefined when no block matches clearly.
 *
 * When several blocks repeat the text, `tieBreak` decides: `viewport` (Reading view,
 * already scrolled to the target line) takes the block nearest the top of the
 * viewport; `position` (an unscrolled preview) takes the block whose position in the
 * rendered text best matches the target's position in the source.
 */
export function findRenderedBlock(
  container: HTMLElement,
  content: string,
  target: AnchorTarget,
  tieBreak: 'viewport' | 'position' = 'viewport',
): HTMLElement | undefined {
  const needle = normalize(target.matchText || headingText(content, target.start)).text;
  if (!needle) return undefined;
  const prefix = needle.slice(0, 24);
  const blocks = Array.from(container.querySelectorAll<HTMLElement>(BLOCK_SELECTOR));
  const contains = (el: HTMLElement, text: string) =>
    normalize(el.textContent ?? '').text.includes(text);
  let matches = blocks.filter((el) => contains(el, needle));
  if (matches.length === 0 && prefix.length >= 12)
    matches = blocks.filter((el) => contains(el, prefix));
  // Prefer the innermost block (a <li> rather than its parent list item's <ul> text).
  matches = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));
  if (matches.length <= 1) return matches[0];
  return tieBreak === 'position'
    ? closestByPosition(container, blocks, matches, target.start / Math.max(1, content.length))
    : closestToViewportTop(container, matches);
}

function closestToViewportTop(container: HTMLElement, matches: HTMLElement[]): HTMLElement {
  const top = container.getBoundingClientRect().top;
  let best = matches[0]!;
  let bestDistance = Infinity;
  for (const el of matches) {
    const distance = Math.abs(el.getBoundingClientRect().top - top);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = el;
    }
  }
  return best;
}

function closestByPosition(
  container: HTMLElement,
  blocks: HTMLElement[],
  matches: HTMLElement[],
  targetFraction: number,
): HTMLElement {
  const total = Math.max(1, (container.textContent ?? '').length);
  let best = matches[0]!;
  let bestDiff = Infinity;
  let consumed = 0;
  for (const block of blocks) {
    if (matches.includes(block)) {
      const diff = Math.abs(consumed / total - targetFraction);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = block;
      }
    }
    consumed += (block.textContent ?? '').length;
  }
  return best;
}

function headingText(content: string, offset: number): string {
  const end = content.indexOf('\n', offset);
  return content.slice(offset, end === -1 ? content.length : end).replace(/^#{1,6}\s+/, '');
}

function flash(app: App, el: HTMLElement): void {
  el.classList.add(FLASH_CLASS);
  let done = false;
  const ref = app.workspace.on('active-leaf-change', () => clear());
  const timer = window.setTimeout(() => clear(), FLASH_MS);
  function clear(): void {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    app.workspace.offref(ref);
    el.classList.remove(FLASH_CLASS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

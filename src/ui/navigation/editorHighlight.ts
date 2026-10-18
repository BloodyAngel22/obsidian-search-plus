import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
  type Text,
} from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from '@codemirror/view';
import { editorInfoField, type MarkdownView } from 'obsidian';

/**
 * A short-lived marker for the passage a search result opened at, in Source mode and
 * Live Preview. It is a CodeMirror decoration registered through
 * `Plugin.registerEditorExtension`, so it never edits the note, never touches the
 * selection, IME or undo history, and disappears after a moment, on the next edit,
 * on the next navigation, when the editor shows another note, or on plugin unload.
 *
 * - `hit`: a verified exact match (identifier or full-text word) is marked inline.
 * - `passage`: a semantic passage gets a subtle line marker; no word is marked, since
 *   nothing matched literally.
 */

export type NavigationHighlightKind = 'hit' | 'passage';

interface HighlightSpec {
  from: number;
  to: number;
  kind: NavigationHighlightKind;
}

const HIT_CLASS = 'search-plus-nav-hit';
const PASSAGE_CLASS = 'search-plus-nav-passage';
/** A passage marker never covers more lines than this. */
const MAX_PASSAGE_LINES = 40;
const DEFAULT_DURATION_MS = 2000;

const setNavigationHighlight = StateEffect.define<HighlightSpec | null>();

function buildDecorations(doc: Text, spec: HighlightSpec): DecorationSet {
  const from = Math.max(0, Math.min(spec.from, doc.length));
  const to = Math.max(from, Math.min(spec.to, doc.length));
  if (spec.kind === 'hit') {
    if (to <= from) return Decoration.none;
    return Decoration.set([Decoration.mark({ class: HIT_CLASS }).range(from, to)]);
  }
  const builder = new RangeSetBuilder<Decoration>();
  const first = doc.lineAt(from).number;
  const last = Math.min(doc.lineAt(Math.max(from, to - 1)).number, first + MAX_PASSAGE_LINES - 1);
  const line = Decoration.line({ class: PASSAGE_CLASS });
  for (let n = first; n <= last; n++) {
    const start = doc.line(n).from;
    builder.add(start, start, line);
  }
  return builder.finish();
}

const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setNavigationHighlight)) {
        return effect.value ? buildDecorations(tr.state.doc, effect.value) : Decoration.none;
      }
    }
    // Any edit (typing, or the editor loading another note) removes the marker: it
    // must never sit on text that is changing.
    return tr.docChanged ? Decoration.none : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Editors that currently carry the extension, to find the one behind a MarkdownView. */
const liveViews = new Set<EditorView>();
const timers = new Map<EditorView, number>();

const viewTracker = ViewPlugin.define((view) => {
  liveViews.add(view);
  return {
    destroy() {
      liveViews.delete(view);
      const timer = timers.get(view);
      if (timer !== undefined) window.clearTimeout(timer);
      timers.delete(view);
    },
  };
});

/** Register once with `plugin.registerEditorExtension(...)`. */
export function navigationHighlightExtension(): Extension {
  return [highlightField, viewTracker];
}

function editorViewFor(markdownView: MarkdownView): EditorView | null {
  for (const view of liveViews) {
    const info = view.state.field(editorInfoField, false);
    if (!info) continue;
    if (info === markdownView || (info.editor && info.editor === markdownView.editor)) return view;
  }
  return null;
}

function clearView(view: EditorView): void {
  const timer = timers.get(view);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.delete(view);
  if (liveViews.has(view)) view.dispatch({ effects: setNavigationHighlight.of(null) });
}

/**
 * Mark `from`–`to` (offsets into the editor text) in the editor of `markdownView` for
 * `durationMs`. Returns false when that editor cannot be found; navigation still works,
 * there is just no marker.
 */
export function flashEditorRange(
  markdownView: MarkdownView,
  from: number,
  to: number,
  kind: NavigationHighlightKind,
  durationMs = DEFAULT_DURATION_MS,
): boolean {
  const view = editorViewFor(markdownView);
  if (!view) return false;
  clearView(view);
  view.dispatch({ effects: setNavigationHighlight.of({ from, to, kind }) });
  timers.set(
    view,
    window.setTimeout(() => clearView(view), durationMs),
  );
  return true;
}

/** Remove every marker and timer (plugin unload). */
export function clearNavigationHighlights(): void {
  for (const view of [...timers.keys()]) clearView(view);
}

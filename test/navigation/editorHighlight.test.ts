import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { editorInfoField, type MarkdownView } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearNavigationHighlights,
  flashEditorRange,
  navigationHighlightExtension,
} from '../../src/ui/navigation/editorHighlight';

const DOC = [
  '# Notes',
  '',
  'ReplacingMergeTree collapses duplicates. MergeTree merges parts.',
  'Second line of the same paragraph.',
  '',
  'Other paragraph.',
].join('\n');

function makeEditor(owner: object, doc = DOC): EditorView {
  const parent = activeDocument.createDiv();
  activeDocument.body.appendChild(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(0),
      extensions: [navigationHighlightExtension(), editorInfoField.init(() => owner as never)],
    }),
  });
}

const marks = (view: EditorView) => view.dom.querySelectorAll('.search-plus-nav-hit');
const passageLines = (view: EditorView) => view.dom.querySelectorAll('.search-plus-nav-passage');

describe('navigation highlight extension', () => {
  let owner: MarkdownView;
  let view: EditorView;

  beforeEach(() => {
    vi.useFakeTimers();
    owner = { editor: {} } as MarkdownView;
    view = makeEditor(owner);
  });

  afterEach(() => {
    clearNavigationHighlights();
    view.destroy();
    vi.useRealTimers();
    activeDocument.body.empty();
  });

  it('marks only the exact identifier, without changing selection or text', () => {
    const start = DOC.indexOf(' MergeTree') + 1;
    expect(flashEditorRange(owner, start, start + 'MergeTree'.length, 'hit')).toBe(true);
    const marked = marks(view);
    expect(marked).toHaveLength(1);
    expect(marked[0]!.textContent).toBe('MergeTree');
    expect(view.state.selection.main.head).toBe(0);
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it('marks the lines of a semantic passage, never a word', () => {
    const start = DOC.indexOf('ReplacingMergeTree');
    const end = DOC.indexOf('paragraph.') + 'paragraph.'.length;
    flashEditorRange(owner, start, end, 'passage');
    expect(passageLines(view)).toHaveLength(2);
    expect(marks(view)).toHaveLength(0);
  });

  it('removes the marker after the duration', () => {
    flashEditorRange(owner, 9, 27, 'hit', 2000);
    vi.advanceTimersByTime(1999);
    expect(marks(view)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(marks(view)).toHaveLength(0);
  });

  it('removes the marker as soon as the text changes (typing, or another note)', () => {
    flashEditorRange(owner, 9, 27, 'hit');
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    expect(marks(view)).toHaveLength(0);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'Another note' } });
    expect(marks(view)).toHaveLength(0);
  });

  it('a new navigation replaces the previous marker', () => {
    flashEditorRange(owner, 9, 27, 'hit');
    const start = DOC.indexOf('Other');
    flashEditorRange(owner, start, start + 5, 'hit');
    const marked = marks(view);
    expect(marked).toHaveLength(1);
    expect(marked[0]!.textContent).toBe('Other');
  });

  it('only marks the editor that belongs to the given view', () => {
    const otherOwner = { editor: {} } as MarkdownView;
    const other = makeEditor(otherOwner);
    flashEditorRange(owner, 9, 27, 'hit');
    expect(marks(view)).toHaveLength(1);
    expect(marks(other)).toHaveLength(0);
    other.destroy();
  });

  it('reports false when the view has no live editor', () => {
    expect(flashEditorRange({ editor: {} } as MarkdownView, 0, 3, 'hit')).toBe(false);
  });

  it('clamps ranges past the end of the text', () => {
    expect(() => flashEditorRange(owner, DOC.length - 3, DOC.length + 50, 'passage')).not.toThrow();
    expect(passageLines(view)).toHaveLength(1);
  });

  it('plugin unload clears every marker and timer', () => {
    const before = vi.getTimerCount(); // CodeMirror keeps its own measuring timers
    flashEditorRange(owner, 9, 27, 'hit');
    expect(vi.getTimerCount()).toBe(before + 1);
    clearNavigationHighlights();
    expect(marks(view)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(before);
  });
});

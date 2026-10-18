import { MarkdownView, TFile, WorkspaceLeaf } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchResult } from '../../src/ipc';
import { findRenderedBlock, openResultAtAnchor } from '../../src/ui/navigation/openResult';

const frontmatter = '---\ntype: learn\n---\n';
const body = [
  '# ClickHouse',
  '',
  '## MergeTree',
  '',
  'MergeTree performs background merges of data parts.',
  '',
  '## Log',
  '',
  'Log engines append rows.',
].join('\n');
const content = frontmatter + body;
const chunk = '## MergeTree\n\nMergeTree performs background merges of data parts.';
const charStart = body.indexOf(chunk);

function result(kind: 'semantic' | 'bm25' = 'semantic'): SearchResult {
  return {
    path: 'db/clickhouse.md',
    title: 'ClickHouse',
    score: 0.9,
    tags: [],
    aliases: [],
    previewAnchors: [
      {
        kind,
        headingPath: '# ClickHouse > ## MergeTree',
        matchText: 'MergeTree performs background merges of data parts.',
        charStart,
        charEnd: charStart + chunk.length,
      },
    ],
    primaryAnchorIndex: 0,
  };
}

interface FakeView {
  file: TFile | null;
  editor: {
    setCursor: ReturnType<typeof vi.fn>;
    setSelection: ReturnType<typeof vi.fn>;
    scrollIntoView: ReturnType<typeof vi.fn>;
  };
  previewMode: { applyScroll: ReturnType<typeof vi.fn>; containerEl: HTMLElement };
}

function setup(mode: 'source' | 'preview', viewData = content) {
  const file = Object.assign(new TFile(), { path: 'db/clickhouse.md' });
  const leaf = new WorkspaceLeaf() as WorkspaceLeaf & { openFile: ReturnType<typeof vi.fn> };
  const previewEl = activeDocument.createDiv();
  activeDocument.body.appendChild(previewEl);
  const view = Object.assign(new MarkdownView(leaf), {
    file: null as TFile | null,
    getMode: () => mode,
    getViewData: () => viewData,
    editor: { setCursor: vi.fn(), setSelection: vi.fn(), scrollIntoView: vi.fn() },
    previewMode: { applyScroll: vi.fn(), containerEl: previewEl },
  }) as unknown as FakeView;
  leaf.openFile = vi.fn(async () => {
    view.file = file;
    leaf.view = view as never;
  });
  const offref = vi.fn();
  const app = {
    vault: { cachedRead: vi.fn().mockResolvedValue(content) },
    workspace: { on: vi.fn().mockReturnValue({}), offref },
  };
  return { app, file, leaf, view, previewEl, offref };
}

describe('openResultAtAnchor', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => {
    vi.useRealTimers();
    activeDocument.body.empty();
  });

  it('opens at the verified passage in Source/Live Preview, cursor only', async () => {
    const ctx = setup('source');
    const target = await openResultAtAnchor(ctx.app as never, ctx.leaf, ctx.file, result(), {
      mode: 'semantic',
      queryWords: ['merges'],
    });
    const line = content.split('\n').indexOf('MergeTree performs background merges of data parts.');
    expect(ctx.leaf.openFile).toHaveBeenCalledWith(ctx.file, { eState: { line } });
    expect(ctx.view.editor.setCursor).toHaveBeenCalledWith({ line, ch: 0 });
    expect(ctx.view.editor.setSelection).not.toHaveBeenCalled();
    expect(ctx.view.editor.scrollIntoView).toHaveBeenCalledWith(
      {
        from: { line, ch: 0 },
        to: { line, ch: 'MergeTree performs background merges of data parts.'.length },
      },
      true,
    );
    expect(target?.confidence).toBe('offset');
  });

  it('selects only the exact query word for full-text matches', async () => {
    const ctx = setup('source');
    await openResultAtAnchor(ctx.app as never, ctx.leaf, ctx.file, result('bm25'), {
      mode: 'fulltext',
      queryWords: ['merges'],
    });
    const line = content.split('\n').indexOf('MergeTree performs background merges of data parts.');
    const ch = 'MergeTree performs background '.length;
    expect(ctx.view.editor.setSelection).toHaveBeenCalledWith(
      { line, ch },
      { line, ch: ch + 'merges'.length },
    );
  });

  it('re-verifies against unsaved editor content', async () => {
    const edited = content.replace('# ClickHouse', '# ClickHouse\n\nNew paragraph.\nAnother line.');
    const ctx = setup('source', edited);
    await openResultAtAnchor(ctx.app as never, ctx.leaf, ctx.file, result(), { mode: 'semantic' });
    const line = edited.split('\n').indexOf('MergeTree performs background merges of data parts.');
    expect(ctx.view.editor.setCursor).toHaveBeenCalledWith({ line, ch: 0 });
  });

  it('opens normally when the anchor cannot be verified', async () => {
    const ctx = setup('source', '# Rewritten note\n\nNothing left.');
    ctx.app.vault.cachedRead.mockResolvedValue('# Rewritten note\n\nNothing left.');
    const target = await openResultAtAnchor(ctx.app as never, ctx.leaf, ctx.file, result());
    expect(target).toBeNull();
    expect(ctx.leaf.openFile).toHaveBeenCalledWith(ctx.file);
    expect(ctx.view.editor.setCursor).not.toHaveBeenCalled();
  });

  it('opens results without anchors (title, metadata-only) without reading the note', async () => {
    const ctx = setup('source');
    const plain: SearchResult = {
      path: 'db/clickhouse.md',
      title: 'C',
      score: 0,
      tags: [],
      aliases: [],
    };
    await openResultAtAnchor(ctx.app as never, ctx.leaf, ctx.file, plain, { active: true });
    expect(ctx.app.vault.cachedRead).not.toHaveBeenCalled();
    expect(ctx.leaf.openFile).toHaveBeenCalledWith(ctx.file, { active: true });
    expect(ctx.view.editor.setCursor).not.toHaveBeenCalled();
  });

  it('scrolls the Reading view and flashes the rendered block, staying in Reading mode', async () => {
    const ctx = setup('preview');
    ctx.previewEl.createEl('h2', { text: 'MergeTree' });
    const para = ctx.previewEl.createEl('p', {
      text: 'MergeTree performs background merges of data parts.',
    });
    await openResultAtAnchor(ctx.app as never, ctx.leaf, ctx.file, result(), { mode: 'semantic' });
    const line = content.split('\n').indexOf('MergeTree performs background merges of data parts.');
    expect(ctx.view.previewMode.applyScroll).toHaveBeenCalledWith(line);
    expect(ctx.view.editor.setCursor).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60);
    expect(para.classList.contains('search-plus-nav-flash')).toBe(true);
    await vi.advanceTimersByTimeAsync(2100);
    expect(para.classList.contains('search-plus-nav-flash')).toBe(false);
    expect(ctx.offref).toHaveBeenCalled();
  });

  it('acts on the leaf it was given, not on another active view', async () => {
    const ctx = setup('source');
    const other = setup('source');
    await openResultAtAnchor(ctx.app as never, ctx.leaf, ctx.file, result());
    expect(ctx.view.editor.setCursor).toHaveBeenCalled();
    expect(other.view.editor.setCursor).not.toHaveBeenCalled();
  });
});

describe('findRenderedBlock', () => {
  it('returns nothing when no rendered block matches', () => {
    const el = activeDocument.createDiv();
    el.createEl('p', { text: 'Unrelated' });
    expect(
      findRenderedBlock(el, 'x', {
        start: 0,
        end: 1,
        matchText: 'Something else',
        confidence: 'offset',
      }),
    ).toBeUndefined();
  });

  it('finds a heading block for heading targets', () => {
    const el = activeDocument.createDiv();
    const h = el.createEl('h3', { text: 'MergeTree' });
    const text = '### MergeTree\nbody';
    expect(
      findRenderedBlock(el, text, { start: 0, end: 13, matchText: '', confidence: 'heading' }),
    ).toBe(h);
  });
});

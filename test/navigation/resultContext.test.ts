import { describe, expect, it } from 'vitest';
import type { MatchAnchor, SearchResult } from '../../src/ipc';
import {
  getResultContext,
  renderResultContext,
  rowHighlightWords,
} from '../../src/ui/navigation/resultContext';

const heading = '# Redis Stream > ## Configuration > ### Analytics export';
const bm25: MatchAnchor = {
  kind: 'bm25',
  headingPath: heading,
  matchText: 'Events are mirrored into ClickHouse tables using the MergeTree engine.',
  charStart: 100,
  charEnd: 200,
  matchStart: 150,
  matchEnd: 159,
};
const semantic: MatchAnchor = { ...bm25, kind: 'semantic', matchStart: undefined };

function result(extra: Partial<SearchResult>): SearchResult {
  return { path: 'redis.md', title: 'Redis', score: 1, tags: [], aliases: [], ...extra };
}

describe('getResultContext', () => {
  it('shows the primary passage heading and its snippet, without the "...### heading" line', () => {
    const ctx = getResultContext(
      result({
        snippet: `${heading}\n...### Analytics export\n\nEvents are mirrored into ClickHouse tables using the MergeTree engine.`,
        snippetSource: 'bm25',
        previewAnchors: [bm25, semantic],
        primaryAnchorIndex: 0,
      }),
    );
    expect(ctx.heading).toBe('Redis Stream → Configuration → Analytics export');
    expect(ctx.snippet).toBe(
      'Events are mirrored into ClickHouse tables using the MergeTree engine.',
    );
  });

  it('drops a snippet that came from another passage than the primary anchor', () => {
    const ctx = getResultContext(
      result({
        snippet: `${heading}\nsome text`,
        snippetSource: 'semantic',
        previewAnchors: [bm25],
        primaryAnchorIndex: 0,
      }),
    );
    expect(ctx.heading).not.toBeNull();
    expect(ctx.snippet).toBeNull();
  });

  it('old engines: drops a snippet that is not prefixed by the anchor heading (note opening)', () => {
    const ctx = getResultContext(
      result({
        snippet: '# Redis Stream\n\nIntro paragraph about streams.',
        previewAnchors: [semantic],
        primaryAnchorIndex: 0,
      }),
    );
    expect(ctx.snippet).toBeNull();
  });

  it('shows nothing for results without a passage (title, metadata, intro snippet)', () => {
    const ctx = getResultContext(result({ snippet: 'Intro text', snippetSource: 'intro' }));
    expect(ctx).toEqual({ heading: null, snippet: null });
  });

  it('truncates long snippets with an ellipsis', () => {
    const long = 'word '.repeat(200);
    const ctx = getResultContext(
      result({ snippet: long, previewAnchors: [{ ...semantic, headingPath: null }] }),
    );
    expect(ctx.snippet!.length).toBeLessThanOrEqual(220);
    expect(ctx.snippet!.endsWith('…')).toBe(true);
  });
});

describe('snippet identifiers', () => {
  it('keeps underscores inside identifiers but drops emphasis markers', () => {
    const r = result({
      snippet: '- `trace_id` — _важно_ and __bold__ with inner_imp_id',
      previewAnchors: [{ ...semantic, headingPath: null }],
      primaryAnchorIndex: 0,
    });
    expect(getResultContext(r).snippet).toBe('- trace_id — важно and bold with inner_imp_id');
  });
});

describe('rowHighlightWords', () => {
  it('marks words only for literal (BM25) primary passages', () => {
    const words = ['mergetree'];
    const lit = result({ previewAnchors: [bm25], primaryAnchorIndex: 0 });
    const sem = result({ previewAnchors: [semantic, bm25], primaryAnchorIndex: 0 });
    expect(rowHighlightWords(lit, 'fulltext', words)).toEqual(words);
    expect(rowHighlightWords(lit, 'hybrid', words)).toEqual(words);
    expect(rowHighlightWords(sem, 'hybrid', words)).toBeNull();
    expect(rowHighlightWords(lit, 'semantic', words)).toBeNull();
    expect(rowHighlightWords(result({}), 'fulltext', words)).toBeNull();
  });

  it('marks words for a hybrid semantic passage only when the engine verified the exact hit', () => {
    const words = ['trace_id'];
    const verified = result({
      previewAnchors: [{ ...semantic, matchStart: 10, matchEnd: 18 }],
      primaryAnchorIndex: 0,
    });
    expect(rowHighlightWords(verified, 'hybrid', words)).toEqual(words);
    expect(rowHighlightWords(verified, 'semantic', words)).toBeNull();
  });

  it('renders marks inside the snippet text', () => {
    const el = activeDocument.createDiv();
    renderResultContext(el, { heading: 'A → B', snippet: 'uses the MergeTree engine' }, [
      'mergetree',
    ]);
    expect(el.querySelector('.search-plus-result-hit')?.textContent).toBe('MergeTree');
    expect(el.querySelector('.search-plus-result-snippet')?.textContent).toBe(
      'uses the MergeTree engine',
    );
  });
});

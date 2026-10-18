import { describe, expect, it } from 'vitest';
import type { MatchAnchor } from '../../src/ipc';
import {
  bodyStartCandidates,
  getPrimaryAnchor,
  resolveAnchorTarget,
} from '../../src/ui/navigation/anchorResolver';
import { getAnchorOffset } from '../../src/ui/noteUtils';

/** Build an anchor the way the engine does: chunk bounds relative to the body. */
function anchorFor(
  body: string,
  chunk: string,
  matchText: string,
  extra: Partial<MatchAnchor> = {},
): MatchAnchor {
  const charStart = body.indexOf(chunk);
  if (charStart === -1) throw new Error('chunk not in body');
  return {
    kind: 'semantic',
    headingPath: null,
    matchText,
    charStart,
    charEnd: charStart + chunk.length,
    ...extra,
  };
}

const frontmatter = '---\ntitle: ClickHouse\ntags: [db]\n---\n';
const body = [
  '# ClickHouse',
  '',
  'Intro text about columnar storage.',
  '',
  '## Table Engines',
  '',
  '### MergeTree',
  '',
  'MergeTree performs background merges of data parts.',
  'Parts are sorted by the primary key.',
  '',
  '### Log',
  '',
  'Log engines are simple and append-only.',
].join('\n');

const mergeChunk =
  '### MergeTree\n\nMergeTree performs background merges of data parts.\nParts are sorted by the primary key.';
const mergeHeading = '# ClickHouse > ## Table Engines > ### MergeTree';

function lineOf(content: string, offset: number): string {
  const start = content.lastIndexOf('\n', offset - 1) + 1;
  const end = content.indexOf('\n', offset);
  return content.slice(start, end === -1 ? content.length : end);
}

describe('bodyStartCandidates', () => {
  it('is 0 without frontmatter', () => {
    expect(bodyStartCandidates(body)).toEqual([0]);
  });

  it('starts after the closing delimiter line with frontmatter', () => {
    expect(bodyStartCandidates(frontmatter + body)).toEqual([frontmatter.length]);
  });

  it('offers the gray-matter position too when the parsers disagree', () => {
    // A closing line with trailing spaces: Obsidian and gray-matter differ by the spaces.
    const content = '---\na: 1\n---  \nBody';
    const candidates = bodyStartCandidates(content);
    expect(candidates).toContain(content.indexOf('Body'));
    expect(candidates.length).toBe(2);
  });
});

describe('resolveAnchorTarget', () => {
  const anchor = anchorFor(
    body,
    mergeChunk,
    'MergeTree performs background merges of data parts.',
    {
      headingPath: mergeHeading,
    },
  );

  it('adds the frontmatter length to body-relative offsets', () => {
    const content = frontmatter + body;
    const target = resolveAnchorTarget(content, anchor)!;
    expect(target.confidence).toBe('offset');
    expect(content.slice(target.start)).toMatch(/^MergeTree performs/);
    // Only the matched line, never the whole chunk.
    expect(content.slice(target.start, target.end)).toBe(
      'MergeTree performs background merges of data parts.',
    );
  });

  it('works without frontmatter', () => {
    const target = resolveAnchorTarget(body, anchor)!;
    expect(body.slice(target.start)).toMatch(/^MergeTree performs/);
  });

  it('matches through Markdown syntax the engine stripped from matchText', () => {
    const md = '## Notes\n\n- **Bold** item with `code` and [[Page|a link]]\n';
    const a = anchorFor(md, md.trim(), 'Bold item with code and a link', {
      headingPath: '## Notes',
    });
    const target = resolveAnchorTarget(md, a)!;
    expect(lineOf(md, target.start)).toBe('- **Bold** item with `code` and [[Page|a link]]');
  });

  it('highlights an exact query word only when asked (full-text)', () => {
    const bm25: MatchAnchor = { ...anchor, kind: 'bm25' };
    const content = frontmatter + body;
    const plain = resolveAnchorTarget(content, bm25, { queryWords: ['merges'] })!;
    expect(plain.highlight).toBeUndefined();
    const exact = resolveAnchorTarget(content, bm25, {
      queryWords: ['merges'],
      highlightExact: true,
    })!;
    expect(content.slice(exact.highlight!.start, exact.highlight!.end)).toBe('merges');
  });

  it('never highlights words for semantic anchors', () => {
    const target = resolveAnchorTarget(frontmatter + body, anchor, {
      queryWords: ['merges'],
      highlightExact: true,
    })!;
    expect(target.highlight).toBeUndefined();
  });

  it('uses context inside the heading section when offsets are null (old index)', () => {
    const old: MatchAnchor = { ...anchor, charStart: null, charEnd: null };
    const content = frontmatter + body;
    const target = resolveAnchorTarget(content, old)!;
    expect(target.confidence).toBe('context');
    expect(content.slice(target.start)).toMatch(/^MergeTree performs/);
  });

  it('recovers from stale offsets after the note was edited above the passage', () => {
    const edited =
      frontmatter + body.replace('Intro text', `Intro text. ${'More words. '.repeat(30)}`);
    const target = resolveAnchorTarget(edited, anchor)!;
    expect(target.confidence).toBe('context');
    expect(edited.slice(target.start)).toMatch(/^MergeTree performs/);
  });

  it('picks the occurrence in the right section when the phrase repeats', () => {
    const repeated = [
      '## Alpha',
      'Shared sentence that appears twice.',
      '## Beta',
      'Shared sentence that appears twice.',
    ].join('\n');
    const stale: MatchAnchor = {
      kind: 'semantic',
      headingPath: '## Beta',
      matchText: 'Shared sentence that appears twice.',
      charStart: null,
      charEnd: null,
    };
    const target = resolveAnchorTarget(repeated, stale)!;
    expect(target.start).toBe(repeated.lastIndexOf('Shared'));
  });

  it('uses the offsets to pick the right repeat when they are still valid', () => {
    const repeated = 'Shared sentence here.\n\nShared sentence here.\n';
    const second = repeated.lastIndexOf('Shared');
    const a: MatchAnchor = {
      kind: 'bm25',
      headingPath: null,
      matchText: 'Shared sentence here.',
      charStart: second,
      charEnd: repeated.length - 1,
    };
    expect(resolveAnchorTarget(repeated, a)!.start).toBe(second);
  });

  it('refuses an ambiguous match instead of taking the first occurrence', () => {
    const repeated = 'Shared sentence that appears twice.\n\nShared sentence that appears twice.\n';
    const a: MatchAnchor = {
      kind: 'bm25',
      headingPath: null,
      matchText: 'Shared sentence that appears twice.',
      charStart: null,
      charEnd: null,
    };
    expect(resolveAnchorTarget(repeated, a)).toBeNull();
    expect(getAnchorOffset(repeated, a)).toBe(-1);
  });

  it('goes to the section heading when the text is gone but the section is unique', () => {
    const edited = body.replace(
      'MergeTree performs background merges of data parts.',
      'Rewritten.',
    );
    const target = resolveAnchorTarget(edited, anchor)!;
    expect(target.confidence).toBe('heading');
    expect(lineOf(edited, target.start)).toBe('### MergeTree');
  });

  it('returns null when neither text nor section can be verified', () => {
    const unrelated = '# Other note\n\nNothing related here.';
    expect(resolveAnchorTarget(unrelated, anchor)).toBeNull();
  });

  it('does not accept a short lone match in the whole note', () => {
    const a: MatchAnchor = {
      kind: 'bm25',
      headingPath: null,
      matchText: 'data',
      charStart: null,
      charEnd: null,
    };
    expect(resolveAnchorTarget('some data here', a)).toBeNull();
  });

  it('ignores offsets that point past the end of the text', () => {
    const a: MatchAnchor = { ...anchor, charStart: 10_000, charEnd: 10_100, headingPath: null };
    // Falls back to a unique context match.
    const target = resolveAnchorTarget(body, a)!;
    expect(target.confidence).toBe('context');
  });

  it('handles Unicode text and decomposed accents', () => {
    const text = '## Заметки\n\nКлючевая идея: café résumé naïve.\n';
    const a: MatchAnchor = {
      kind: 'semantic',
      headingPath: '## Заметки',
      matchText: 'Ключевая идея: café résumé naïve.'.normalize('NFD'),
      charStart: null,
      charEnd: null,
    };
    const target = resolveAnchorTarget(text, a)!;
    expect(text.slice(target.start)).toMatch(/^Ключевая/);
  });

  it('does not take headings inside code fences as sections', () => {
    const text = [
      '## Real',
      '```bash',
      '## Real',
      'echo hi',
      '```',
      'Unique line inside the real section.',
    ].join('\n');
    const a: MatchAnchor = {
      kind: 'semantic',
      headingPath: '## Real',
      matchText: 'Unique line inside the real section.',
      charStart: null,
      charEnd: null,
    };
    expect(resolveAnchorTarget(text, a)!.confidence).toBe('context');
  });

  it('finds table rows', () => {
    const text =
      '## Data\n\n| Engine | Use |\n| --- | --- |\n| MergeTree | analytics workloads |\n';
    const a: MatchAnchor = {
      kind: 'bm25',
      headingPath: '## Data',
      matchText: '| MergeTree | analytics workloads |',
      charStart: null,
      charEnd: null,
    };
    const target = resolveAnchorTarget(text, a)!;
    expect(lineOf(text, target.start)).toBe('| MergeTree | analytics workloads |');
  });

  it('checks a heading-only chunk by its heading line', () => {
    const text = '# Title\n\n## Empty section\n';
    const a: MatchAnchor = {
      kind: 'semantic',
      headingPath: '# Title > ## Empty section',
      matchText: '',
      charStart: text.indexOf('## Empty'),
      charEnd: text.length - 1,
    };
    expect(resolveAnchorTarget(text, a)!.start).toBe(text.indexOf('## Empty'));
  });
});

describe('getPrimaryAnchor', () => {
  const a: MatchAnchor = {
    kind: 'semantic',
    headingPath: null,
    matchText: 'a',
    charStart: 0,
    charEnd: 1,
  };
  const b: MatchAnchor = { ...a, kind: 'bm25', matchText: 'b' };

  it('uses primaryAnchorIndex, defaulting to the first anchor', () => {
    expect(getPrimaryAnchor({ previewAnchors: [a, b], primaryAnchorIndex: 1 })).toBe(b);
    expect(getPrimaryAnchor({ previewAnchors: [a, b] })).toBe(a);
    expect(getPrimaryAnchor({ previewAnchors: [a, b], primaryAnchorIndex: 5 })).toBe(a);
    expect(getPrimaryAnchor({})).toBeUndefined();
  });
});

describe('exact hits and repeats inside a chunk', () => {
  const fm = '---\ntype: learn\n---\n';
  const body = [
    '## Notes',
    '',
    'Retry the job later.',
    'Some filler words in between.',
    'Retry the job later with ReplacingMergeTree dedup.',
  ].join('\n');
  const content = fm + body;
  const hitStart = body.indexOf('ReplacingMergeTree');
  const bm25: MatchAnchor = {
    kind: 'bm25',
    headingPath: '## Notes',
    matchText: 'Retry the job later with ReplacingMergeTree dedup.',
    charStart: 0,
    charEnd: body.length,
    matchStart: hitStart,
    matchEnd: hitStart + 'ReplacingMergeTree'.length,
  };

  it('uses the engine exact hit (body offsets + frontmatter) and highlights it', () => {
    const target = resolveAnchorTarget(content, bm25, { highlightExact: true })!;
    expect(target.confidence).toBe('exact');
    expect(content.slice(target.start)).toMatch(/^ReplacingMergeTree/);
    expect(content.slice(target.highlight!.start, target.highlight!.end)).toBe(
      'ReplacingMergeTree',
    );
  });

  it('does not highlight the exact hit for semantic searches', () => {
    expect(
      resolveAnchorTarget(content, bm25, { highlightExact: false })!.highlight,
    ).toBeUndefined();
  });

  it('rejects a stale exact hit whose line changed, then falls back safely', () => {
    const edited = content.replace(
      'Some filler words in between.',
      'Added a much longer line here.',
    );
    const target = resolveAnchorTarget(edited, bm25, { highlightExact: true });
    expect(target?.confidence).not.toBe('exact');
    // The matched line is unique in the chunk, so the line itself is still found.
    expect(edited.slice(target!.start)).toMatch(/^Retry the job later with/);
  });

  it('does not take the first repeat of a BM25 line inside a chunk as the hit', () => {
    const repeated = 'Shared line.\nOther text.\nShared line.\n';
    const a: MatchAnchor = {
      kind: 'bm25',
      headingPath: null,
      matchText: 'Shared line.',
      charStart: 0,
      charEnd: repeated.length,
    };
    const target = resolveAnchorTarget(repeated, a, {
      highlightExact: true,
      queryWords: ['shared'],
    })!;
    expect(target.confidence).toBe('chunk');
    expect(target.start).toBe(0);
    expect(target.highlight).toBeUndefined();
  });

  it('accepts a repeated semantic opening line at the start of its chunk', () => {
    const text = '## Topic\n\nShared line.\nOther text.\nShared line.\n';
    const a: MatchAnchor = {
      kind: 'semantic',
      headingPath: '## Topic',
      matchText: 'Shared line.',
      charStart: 0,
      charEnd: text.length,
    };
    const target = resolveAnchorTarget(text, a)!;
    expect(target.confidence).toBe('offset');
    expect(target.start).toBe(text.indexOf('Shared line.'));
  });
});

describe('selected passage (newer engines)', () => {
  const fm = '---\ntags: [db]\n---\n';
  const passageBody = [
    '### Что я узнал нового для себя',
    '',
    'Clickhouse хранит данные не в одной непрерывной таблице, а в отдельных частях.',
    '',
    'Когда в clickhouse поступают новые записи, clickhouse создает части. Позже части объединяются (merge).',
    '',
    '`ReplacingMergeTree` - схлопывает дубликаты. MergeTree хранит части.',
    '',
    '## Повтор',
    '',
    'Clickhouse хранит данные не в одной непрерывной таблице, а в отдельных частях.',
  ].join('\n');
  const text = fm + passageBody;
  const answer =
    'Когда в clickhouse поступают новые записи, clickhouse создает части. Позже части объединяются (merge).';
  const chunkStart = 0;

  function passageAnchor(passage: string, extra: Partial<MatchAnchor> = {}): MatchAnchor {
    const passageStart = passageBody.indexOf(passage);
    return {
      kind: 'semantic',
      headingPath: '### Что я узнал нового для себя',
      matchText: passage.slice(0, 80),
      charStart: chunkStart,
      charEnd: passageBody.indexOf('## Повтор'),
      passageStart,
      passageEnd: passageStart + passage.length,
      ...extra,
    };
  }

  it('goes to the selected paragraph, not the chunk start (ClickHouse)', () => {
    const target = resolveAnchorTarget(text, passageAnchor(answer));
    expect(target?.confidence).toBe('passage');
    expect(target?.start).toBe(text.indexOf('Когда в clickhouse'));
    expect(target?.passage).toEqual({
      start: text.indexOf(answer),
      end: text.indexOf(answer) + answer.length,
    });
    expect(target?.highlight).toBeUndefined();
  });

  it('uses offsets, so text repeated in another section is never the target', () => {
    const first = 'Clickhouse хранит данные не в одной непрерывной таблице, а в отдельных частях.';
    const target = resolveAnchorTarget(text, passageAnchor(first));
    expect(target?.start).toBe(text.indexOf(first));
    expect(target?.start).toBeLessThan(text.indexOf('## Повтор'));
  });

  it('targets and highlights a verified exact identifier, never one inside a longer one', () => {
    const passage = '`ReplacingMergeTree` - схлопывает дубликаты. MergeTree хранит части.';
    const exact = passageBody.indexOf(' MergeTree') + 1;
    const good = passageAnchor(passage, { matchStart: exact, matchEnd: exact + 9 });
    const target = resolveAnchorTarget(text, good, {
      highlightExact: true,
      queryWords: ['mergetree'],
    });
    expect(text.slice(target!.highlight!.start, target!.highlight!.end)).toBe('MergeTree');
    expect(target?.start).toBe(target!.highlight!.start);
    // Offsets pointing into "ReplacingMergeTree": not a whole token, so no highlight.
    const inside = passageBody.indexOf('MergeTree`');
    const bad = passageAnchor(passage, { matchStart: inside, matchEnd: inside + 9 });
    const fallback = resolveAnchorTarget(text, bad, {
      highlightExact: true,
      queryWords: ['mergetree'],
    });
    expect(fallback?.highlight).toBeUndefined();
    expect(fallback?.start).toBe(text.indexOf(passage));
  });

  it('does not highlight when exact highlighting is off (semantic mode)', () => {
    const passage = '`ReplacingMergeTree` - схлопывает дубликаты. MergeTree хранит части.';
    const exact = passageBody.indexOf(' MergeTree') + 1;
    const target = resolveAnchorTarget(
      text,
      passageAnchor(passage, { matchStart: exact, matchEnd: exact + 9 }),
      { highlightExact: false },
    );
    expect(target?.highlight).toBeUndefined();
    expect(target?.start).toBe(text.indexOf(passage));
  });

  it('falls back to the older checks when the note was edited above the passage', () => {
    const edited = fm + 'A new first line.\n\n' + passageBody;
    const target = resolveAnchorTarget(edited, passageAnchor(answer));
    expect(target?.confidence).not.toBe('passage');
    expect(target?.start).toBe(edited.indexOf(answer));
  });

  it('rejects a semantic passage whose first line no longer holds its text', () => {
    const anchor = passageAnchor(answer, { matchText: 'совсем другой текст которого нет' });
    const target = resolveAnchorTarget(text, anchor);
    expect(target?.confidence).not.toBe('passage');
  });
});

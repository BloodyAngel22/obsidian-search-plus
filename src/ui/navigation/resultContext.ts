import type { SearchResult } from '../../ipc';
import { getPrimaryAnchor } from './anchorResolver';

export interface ResultContext {
  /** Heading path of the matched passage, e.g. "Table Engines → MergeTree". */
  heading: string | null;
  /** A short single-line excerpt of the matched passage. */
  snippet: string | null;
}

const SNIPPET_CHARS = 220;

/**
 * Compact context for a result row, built only from data the engine already sent.
 *
 * The heading and the snippet always describe the primary passage — the one opening
 * the result navigates to. A snippet is shown only when it provably comes from that
 * passage: results without an anchor (title and metadata matches, whose snippet is
 * just the note opening) show none, and a snippet from another passage is dropped.
 */
export function getResultContext(result: SearchResult, maxChars = SNIPPET_CHARS): ResultContext {
  const anchor = getPrimaryAnchor(result);
  if (!anchor) return { heading: null, snippet: null };
  const rawHeading = anchor.headingPath ?? null;
  const heading = rawHeading ? formatHeadingPath(rawHeading) : null;
  return {
    heading,
    snippet:
      result.snippet && snippetMatchesAnchor(result, rawHeading)
        ? cleanSnippet(result.snippet, rawHeading, maxChars)
        : null,
  };
}

function snippetMatchesAnchor(result: SearchResult, headingPath: string | null): boolean {
  const anchor = getPrimaryAnchor(result)!;
  // Newer engines say which passage the snippet came from.
  if (result.snippetSource) return result.snippetSource === anchor.kind;
  // Older engines prefix passage snippets with their heading path; a snippet without
  // it came from somewhere else (e.g. the note opening) and would not match the target.
  if (!headingPath) return true;
  return result.snippet!.split('\n', 1)[0]!.trim() === headingPath.trim();
}

/**
 * Query words to mark in a row snippet: only for literal evidence, i.e. BM25 passages and
 * hybrid semantic passages the engine verified to hold the exact identifier or phrase
 * (`matchStart`). Other semantic passages, and semantic mode, never mark words.
 */
export function rowHighlightWords(
  result: SearchResult,
  mode: string,
  queryWords: readonly string[],
): readonly string[] | null {
  const anchor = getPrimaryAnchor(result);
  if (!anchor || (anchor.kind !== 'bm25' && typeof anchor.matchStart !== 'number')) return null;
  return mode === 'fulltext' || mode === 'hybrid' ? queryWords : null;
}

/** One muted line of ranking and passage details, for the optional diagnostics view. */
export function renderDiagnostics(parent: HTMLElement, result: SearchResult): HTMLElement {
  const parts: string[] = [];
  const fmt = (n: number | null | undefined) => (typeof n === 'number' ? n.toFixed(3) : null);
  const scores = result.scores ?? {};
  const pairs: Array<[string, number | null | undefined]> = [
    ['score', result.score],
    ['rrf', scores.hybrid],
    ['bm25', scores.bm25],
    ['sem', scores.semantic],
    ['title', scores.fuzzy_title],
  ];
  for (const [label, value] of pairs) {
    const text = fmt(value);
    if (text !== null) parts.push(`${label} ${text}`);
  }
  const anchor = getPrimaryAnchor(result);
  if (anchor) {
    parts.push(`passage ${anchor.kind}`);
    if (typeof anchor.charStart === 'number')
      parts.push(`chunk ${anchor.charStart}–${anchor.charEnd}`);
    if (typeof anchor.matchStart === 'number')
      parts.push(`hit ${anchor.matchStart}–${anchor.matchEnd}`);
    if ((result.previewAnchors?.length ?? 0) > 1)
      parts.push(`+${result.previewAnchors!.length - 1} anchor`);
  } else {
    parts.push('no passage');
  }
  if (result.snippetSource) parts.push(`snippet ${result.snippetSource}`);
  return parent.createDiv({ cls: 'search-plus-result-diagnostics', text: parts.join(' · ') });
}

function formatHeadingPath(headingPath: string): string {
  return headingPath
    .split(' > ')
    .map((part) => part.replace(/^#{1,6}\s+/, '').trim())
    .filter(Boolean)
    .join(' → ');
}

/** The engine prefixes snippets with the heading path line; drop it and Markdown noise. */
function cleanSnippet(
  snippet: string,
  headingPath: string | null,
  maxChars: number,
): string | null {
  let lines = snippet.split('\n');
  if (headingPath && lines[0]?.trim() === headingPath.trim()) lines = lines.slice(1);
  /* eslint-disable sonarjs/slow-regex -- link stripping is bounded to one engine snippet (a few hundred characters) */
  const text = lines
    // A BM25 window can start with "..." right before a heading line.
    .map((line) => line.replace(/^\.{3}(?=\s*#)/, ''))
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .join(' ')
    .replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]+|~~/g, '')
    // "_" marks emphasis only at word edges; inside identifiers (trace_id) it stays.
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '')
    .replace(/^\s*(?:>\s*)+/, '')
    .replace(/\s+/g, ' ')
    .replace(/^\.{3}\s*/, '')
    .trim();
  /* eslint-enable sonarjs/slow-regex */
  if (!text) return null;
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
}

/**
 * Render the context under a result title. Query words are highlighted only when
 * `highlightWords` is given (full-text matches); semantic results never mark words.
 */
export function renderResultContext(
  parent: HTMLElement,
  context: ResultContext,
  highlightWords: readonly string[] | null,
): HTMLElement | null {
  if (!context.heading && !context.snippet) return null;
  const el = parent.createDiv({ cls: 'search-plus-result-context' });
  if (context.heading) {
    el.createDiv({
      cls: 'search-plus-result-heading',
      text: context.heading,
      attr: { title: context.heading },
    });
  }
  if (context.snippet) {
    const snippetEl = el.createDiv({ cls: 'search-plus-result-snippet' });
    appendHighlighted(snippetEl, context.snippet, highlightWords ?? []);
  }
  return el;
}

export function appendHighlighted(el: HTMLElement, text: string, words: readonly string[]): void {
  const needles = words.map((w) => w.toLowerCase()).filter((w) => w.length >= 2);
  if (needles.length === 0) {
    el.textContent = text;
    return;
  }
  const lower = text.toLowerCase();
  let pos = 0;
  while (pos < text.length) {
    let next = -1;
    let length = 0;
    for (const needle of needles) {
      const index = lower.indexOf(needle, pos);
      if (index !== -1 && (next === -1 || index < next)) {
        next = index;
        length = needle.length;
      }
    }
    if (next === -1) break;
    if (next > pos) el.appendText(text.slice(pos, next));
    el.createSpan({ cls: 'search-plus-result-hit', text: text.slice(next, next + length) });
    pos = next + length;
  }
  if (pos < text.length) el.appendText(text.slice(pos));
}

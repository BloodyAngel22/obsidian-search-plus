import type { SearchResult } from '../../ipc';
import { getPrimaryAnchor } from './anchorResolver';

export interface ResultContext {
  /** Heading path of the matched passage, e.g. "Table Engines → MergeTree". */
  heading: string | null;
  /** A short single-line excerpt of the matched passage. */
  snippet: string | null;
}

const SNIPPET_CHARS = 160;

/**
 * Compact context for a result row, built only from data the engine already sent.
 * Metadata-only and title results have neither and render nothing.
 */
export function getResultContext(result: SearchResult): ResultContext {
  const anchor = getPrimaryAnchor(result);
  const rawHeading = anchor?.headingPath ?? null;
  const heading = rawHeading ? formatHeadingPath(rawHeading) : null;
  return { heading, snippet: result.snippet ? cleanSnippet(result.snippet, rawHeading) : null };
}

function formatHeadingPath(headingPath: string): string {
  return headingPath
    .split(' > ')
    .map((part) => part.replace(/^#{1,6}\s+/, '').trim())
    .filter(Boolean)
    .join(' → ');
}

/** The engine prefixes snippets with the heading path line; drop it and Markdown noise. */
function cleanSnippet(snippet: string, headingPath: string | null): string | null {
  let lines = snippet.split('\n');
  if (headingPath && lines[0]?.trim() === headingPath.trim()) lines = lines.slice(1);
  /* eslint-disable sonarjs/slow-regex -- link stripping is bounded to one engine snippet (a few hundred characters) */
  const text = lines
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .join(' ')
    .replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/^\s*(?:>\s*)+/, '')
    .replace(/\s+/g, ' ')
    .replace(/^\.{3}\s*/, '')
    .trim();
  /* eslint-enable sonarjs/slow-regex */
  if (!text) return null;
  return text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS - 1).trimEnd()}…` : text;
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

function appendHighlighted(el: HTMLElement, text: string, words: readonly string[]): void {
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

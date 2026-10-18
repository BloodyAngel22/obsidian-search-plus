import { getFrontMatterInfo } from 'obsidian';
import type { MatchAnchor } from '../../ipc';

/**
 * Turns an engine match anchor into a verified position in the current Markdown text.
 *
 * Engine facts this relies on (see the engine's chunker and searcher):
 * - `charStart`/`charEnd` are the CHUNK bounds, relative to the note body AFTER the
 *   YAML frontmatter was removed (gray-matter), not the bounds of a matched word.
 * - `matchText` is one line of the chunk with Markdown syntax stripped, at most 80
 *   characters: the first body line for semantic anchors, the line holding the FTS
 *   hit for BM25 anchors.
 * - `headingPath` is the chunk's raw heading lines joined with " > ".
 * - Newer engines narrow the chunk to one passage (`passageStart`/`passageEnd`, same
 *   coordinates): it starts at a line start, and `matchText` is then its first line
 *   (semantic) or the hit line inside it (BM25).
 * - Chunks indexed by older engines have null offsets.
 *
 * Nothing here trusts an offset blindly: a position is returned only when the text at
 * that position still matches the anchor, or when a lookup inside the anchor's section
 * finds exactly one match. Anything else returns null and the note opens normally.
 */

type AnchorConfidence =
  /** The engine's selected passage is still where its offsets say. */
  | 'passage'
  /** The engine's exact hit offsets (BM25 `matchStart`) still point at the matched line. */
  | 'exact'
  /** The stored offsets still point at the anchor text. */
  | 'offset'
  /** The chunk is verified, but its text repeats inside it: go to the chunk start. */
  | 'chunk'
  /** The offsets were stale or missing; a unique match was found by context. */
  | 'context'
  /** Only the anchor's section heading could be verified. */
  | 'heading';

export interface AnchorTarget {
  /** Start of the relevant passage, as an offset into the full document. */
  start: number;
  /** End of the matched line (the passage scrolled into view), never the whole chunk. */
  end: number;
  /** A verified exact literal match worth highlighting (never in semantic mode). */
  highlight?: { start: number; end: number };
  /** The verified passage, for a subtle block marker when nothing literal matched. */
  passage?: { start: number; end: number };
  /** Text to look for in rendered (Reading view) blocks. Empty for heading targets. */
  matchText: string;
  confidence: AnchorConfidence;
}

export interface ResolveOptions {
  /** Words of the query; used only to highlight an exact full-text match. */
  queryWords?: readonly string[];
  /** Highlight exact query words inside the matched line (BM25 anchors only). */
  highlightExact?: boolean;
}

/** Below this many normalized characters a lone match in the whole note is not proof. */
const MIN_GLOBAL_MATCH_CHARS = 12;
/** Prefix length tried when the full line does not match (links rewrite the line). */
const PREFIX_MATCH_CHARS = 24;

export function getPrimaryAnchor(source: {
  previewAnchors?: MatchAnchor[];
  primaryAnchorIndex?: number;
}): MatchAnchor | undefined {
  const anchors = source.previewAnchors;
  if (!anchors || anchors.length === 0) return undefined;
  const index =
    typeof source.primaryAnchorIndex === 'number' && source.primaryAnchorIndex >= 0
      ? source.primaryAnchorIndex
      : 0;
  return anchors[index] ?? anchors[0];
}

export function resolveAnchorTarget(
  content: string,
  anchor: MatchAnchor,
  options: ResolveOptions = {},
): AnchorTarget | null {
  const bases = bodyStartCandidates(content);
  // The exact hit is used (as target and highlight) only where literal matches count;
  // semantic mode goes to the passage start.
  const passage = resolveByPassage(
    content,
    anchor,
    bases,
    options.queryWords ?? [],
    options.highlightExact ?? false,
  );
  if (passage) return passage;
  const exact = resolveExactHit(content, anchor, bases, options.queryWords ?? []);
  const target =
    exact?.target ??
    resolveByOffsets(content, anchor, bases) ??
    resolveByContext(content, anchor, bases[0]!);
  if (!target) return null;
  // Only verified literal evidence is highlighted: the engine's exact hit, or a query
  // word found in the verified matched line. Chunk and heading fallbacks never are.
  if (options.highlightExact && anchor.kind === 'bm25') {
    if (exact) {
      target.highlight = exact.hit;
    } else if (target.confidence === 'offset' || target.confidence === 'context') {
      const highlight = findQueryWord(content, target.start, target.end, options.queryWords ?? []);
      if (highlight) target.highlight = highlight;
    }
  }
  return target;
}

/**
 * The engine's selected passage, verified: it must still start at a line start, fit
 * in the text, and hold the anchor's `matchText` (on its first line for semantic
 * anchors, whose `matchText` is that line). The target is the exact hit when `useHit`
 * and the hit is verified too (inside the passage, one line, whole token), else the
 * passage start.
 * A note edited above the passage shifts it off its text and the older checks run.
 */
function resolveByPassage(
  content: string,
  anchor: MatchAnchor,
  bases: number[],
  queryWords: readonly string[],
  useHit: boolean,
): AnchorTarget | null {
  const { passageStart, passageEnd } = anchor;
  if (typeof passageStart !== 'number' || typeof passageEnd !== 'number') return null;
  if (passageStart < 0 || passageEnd <= passageStart) return null;
  for (const base of bases) {
    const start = base + passageStart;
    const end = base + passageEnd;
    if (end > content.length || (start > 0 && content[start - 1] !== '\n')) continue;
    if (anchor.matchText) {
      const matches = findAllInRange(content, start, end, anchor.matchText);
      if (matches.length === 0) continue;
      if (anchor.kind === 'semantic' && matches[0]!.start > lineEnd(content, start)) continue;
    }
    const hit = useHit ? verifiedHit(content, anchor, base, start, end, queryWords) : undefined;
    const focus = hit?.start ?? start;
    return {
      start: focus,
      end: lineEnd(content, focus),
      matchText: anchor.matchText,
      confidence: 'passage',
      passage: { start, end },
      ...(hit && { highlight: hit }),
    };
  }
  return null;
}

function verifiedHit(
  content: string,
  anchor: MatchAnchor,
  base: number,
  passageStart: number,
  passageEnd: number,
  queryWords: readonly string[],
): { start: number; end: number } | undefined {
  const { matchStart, matchEnd } = anchor;
  if (typeof matchStart !== 'number' || typeof matchEnd !== 'number') return undefined;
  const start = base + matchStart;
  const end = base + matchEnd;
  if (start < passageStart || end > passageEnd || end <= start) return undefined;
  if (content.slice(start, end).includes('\n')) return undefined;
  return isWholeTokenHit(content, start, end, queryWords) ? { start, end } : undefined;
}

/**
 * BM25 anchors from newer engines carry the exact hit (`matchStart`/`matchEnd`, body
 * relative). It is trusted only when it still lies inside the anchor's chunk, stays on
 * one line, sits on word boundaries, agrees with a query word (when known), and its
 * line still contains the anchor's `matchText`. A note edited above the hit shifts it
 * off the word, so the check fails and the slower fallbacks run instead.
 */
function resolveExactHit(
  content: string,
  anchor: MatchAnchor,
  bases: number[],
  queryWords: readonly string[],
): { target: AnchorTarget; hit: { start: number; end: number } } | null {
  const { matchStart, matchEnd } = anchor;
  if (typeof matchStart !== 'number' || typeof matchEnd !== 'number') return null;
  if (matchStart < 0 || matchEnd <= matchStart) return null;
  for (const base of bases) {
    const start = base + matchStart;
    const end = base + matchEnd;
    if (end > content.length || content.slice(start, end).includes('\n')) continue;
    if (typeof anchor.charStart === 'number' && typeof anchor.charEnd === 'number') {
      if (start < base + anchor.charStart || end > base + anchor.charEnd) continue;
    }
    if (!isWholeTokenHit(content, start, end, queryWords)) continue;
    const lineStart = content.lastIndexOf('\n', start - 1) + 1;
    const stop = lineEnd(content, start);
    if (
      anchor.matchText &&
      findAllInRange(content, lineStart, stop, anchor.matchText).length === 0
    ) {
      continue;
    }
    return {
      target: { start, end: stop, matchText: anchor.matchText, confidence: 'exact' },
      hit: { start, end },
    };
  }
  return null;
}

/**
 * Offsets where the note body can start. Obsidian's own frontmatter parser comes
 * first; a gray-matter style computation (what the engine used) is the second
 * candidate, because the two disagree on unusual delimiter lines. Each candidate is
 * verified against the text, so offering both cannot cause a wrong jump.
 */
export function bodyStartCandidates(content: string): number[] {
  const candidates: number[] = [];
  const info = getFrontMatterInfo(content);
  if (info.exists) candidates.push(info.contentStart);
  const grayMatter = grayMatterBodyStart(content);
  if (!candidates.includes(grayMatter)) candidates.push(grayMatter);
  return candidates;
}

/** Mirrors gray-matter's parseMatter: body starts after "\n---" plus one optional CR/LF. */
function grayMatterBodyStart(content: string): number {
  if (!content.startsWith('---') || content.charAt(3) === '-') return 0;
  const close = content.indexOf('\n---', 3);
  if (close === -1) return 0;
  let start = close + 4;
  if (content[start] === '\r') start++;
  if (content[start] === '\n') start++;
  return start;
}

function resolveByOffsets(
  content: string,
  anchor: MatchAnchor,
  bases: number[],
): AnchorTarget | null {
  if (typeof anchor.charStart !== 'number' || typeof anchor.charEnd !== 'number') return null;
  if (anchor.charStart < 0 || anchor.charEnd < anchor.charStart) return null;
  for (const base of bases) {
    const start = base + anchor.charStart;
    const end = base + anchor.charEnd;
    if (end > content.length) continue;
    if (anchor.matchText) {
      const matches = findAllInRange(content, start, end, anchor.matchText);
      if (matches.length === 0) continue;
      const first = matches[0]!;
      // One occurrence is proof. With repeats, a semantic anchor's text is the chunk's
      // opening line, so its first occurrence counts only when nothing but headings or
      // blank lines precede it; otherwise only the chunk itself is verified.
      if (
        matches.length === 1 ||
        (anchor.kind === 'semantic' && opensChunk(content, start, first.start))
      ) {
        return { ...lineSpan(content, first), matchText: anchor.matchText, confidence: 'offset' };
      }
      return { start, end: lineEnd(content, start), matchText: '', confidence: 'chunk' };
    }
    // No text to compare (e.g. a chunk made only of a heading): the chunk must still
    // begin with the anchor's own heading line.
    const heading = lastHeading(anchor.headingPath);
    if (heading && sameHeading(lineAt(content, start), heading)) {
      return { start, end: lineEnd(content, start), matchText: '', confidence: 'offset' };
    }
  }
  return null;
}

function resolveByContext(content: string, anchor: MatchAnchor, base: number): AnchorTarget | null {
  const sections = anchor.headingPath ? findSections(content, base, anchor.headingPath) : [];
  if (anchor.headingPath && sections.length > 0) {
    if (anchor.matchText) {
      const matches = sections.flatMap((section) =>
        findAllInRange(content, section.start, section.end, anchor.matchText),
      );
      if (matches.length === 1) {
        return {
          ...lineSpan(content, matches[0]!),
          matchText: anchor.matchText,
          confidence: 'context',
        };
      }
    }
    // The section itself is still there; jump to its heading when it is unique.
    if (sections.length === 1) {
      const start = sections[0]!.start;
      return { start, end: lineEnd(content, start), matchText: '', confidence: 'heading' };
    }
    return null;
  }
  // No usable heading: a match in the whole body counts only when it is unique and long
  // enough not to be a coincidence.
  if (!anchor.matchText || normalize(anchor.matchText).text.length < MIN_GLOBAL_MATCH_CHARS) {
    return null;
  }
  const matches = findAllInRange(content, base, content.length, anchor.matchText);
  if (matches.length !== 1) return null;
  return { ...lineSpan(content, matches[0]!), matchText: anchor.matchText, confidence: 'context' };
}

// ── Text matching ──────────────────────────────────────────────────────────────────

interface Normalized {
  /** Letters and digits only, lowercased, accents removed. */
  text: string;
  /** Source offset of each character of `text`. */
  map: number[];
}

/**
 * Comparable form of Markdown text: only letters and digits survive, so emphasis,
 * list markers, quote markers and spacing differences between the raw note and the
 * engine's stripped `matchText` do not matter.
 */
export function normalize(source: string, from = 0, to = source.length): Normalized {
  let text = '';
  const map: number[] = [];
  const skips = hiddenRanges(source, from, to);
  let skip = 0;
  let index = from;
  while (index < to) {
    while (skip < skips.length && skips[skip]![1] <= index) skip++;
    const hidden = skips[skip];
    if (hidden && hidden[0] <= index) {
      index = hidden[1];
      continue;
    }
    const codePoint = source.codePointAt(index)!;
    const char = String.fromCodePoint(codePoint);
    const folded = char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (const out of folded) {
      if (/[\p{L}\p{N}]/u.test(out)) {
        text += out;
        map.push(index);
      }
    }
    index += char.length;
  }
  return { text, map };
}

/**
 * Source ranges the engine drops from `matchText`: wiki link targets before "|",
 * Markdown link URLs, embeds and footnote references. Sorted by start.
 */
function hiddenRanges(source: string, from: number, to: number): Array<[number, number]> {
  const slice = source.slice(from, to);
  const ranges: Array<[number, number]> = [];
  const add = (regex: RegExp) => {
    for (const m of slice.matchAll(regex))
      ranges.push([from + m.index, from + m.index + m[0].length]);
  };
  /* eslint-disable sonarjs/slow-regex -- each pattern is a negated class closed by a fixed character and cannot cross a line */
  // ![[embed]] → removed entirely.
  add(/!\[\[[^\]\n]*\]\]/g);
  // [[target|label]] → only the label is kept.
  add(/(?<!!)\[\[[^\]|\n]*\|/g);
  // [label](url) → only the label is kept.
  add(/\]\([^)\n]*\)/g);
  // [^1] footnote references.
  add(/\[\^[^\]\n]+\]/g);
  /* eslint-enable sonarjs/slow-regex */
  return ranges.sort((a, b) => a[0] - b[0]);
}

interface Match {
  start: number;
  end: number;
}

function findAllInRange(content: string, from: number, to: number, needle: string): Match[] {
  const full = normalize(needle).text;
  const exact = findAll(content, from, to, full);
  if (exact.length > 0) return exact;
  // Wiki links and Markdown links are stored as their labels only, so a line with a
  // link can differ from the raw text after the link. The line start still matches.
  const prefix = full.slice(0, PREFIX_MATCH_CHARS);
  if (prefix.length < MIN_GLOBAL_MATCH_CHARS || prefix === full) return [];
  return findAll(content, from, to, prefix);
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWholeTokenHit(
  content: string,
  start: number,
  end: number,
  queryWords: readonly string[],
): boolean {
  const before = content[start - 1];
  const after = content[end];
  if (!WORD_CHAR.test(content[start] ?? '') || !WORD_CHAR.test(content[end - 1] ?? '')) {
    return false;
  }
  if ((before && WORD_CHAR.test(before)) || (after && WORD_CHAR.test(after))) return false;
  const hit = normalize(content, start, end).text;
  if (!hit) return false;
  const words = queryWords.map((w) => normalize(w).text).filter(Boolean);
  // FTS matches query words as prefixes, and splits snake_case into separate hits.
  return words.length === 0 || words.some((w) => hit.startsWith(w) || w.startsWith(hit));
}

/** True when only heading lines, blank lines or fence markers come before `offset`. */
function opensChunk(content: string, chunkStart: number, offset: number): boolean {
  return content
    .slice(chunkStart, offset)
    .split('\n')
    .slice(0, -1)
    .every((line) => line.trim() === '' || /^\s*#{1,6}\s/.test(line));
}

function findAll(content: string, from: number, to: number, needle: string): Match[] {
  if (!needle) return [];
  const haystack = normalize(content, from, to);
  const matches: Match[] = [];
  let index = haystack.text.indexOf(needle);
  while (index !== -1) {
    const last = haystack.map[index + needle.length - 1]!;
    const lastChar = String.fromCodePoint(content.codePointAt(last)!);
    matches.push({ start: haystack.map[index]!, end: last + lastChar.length });
    index = haystack.text.indexOf(needle, index + 1);
  }
  return matches;
}

/** The match start, and the end of its line (enough to scroll the passage into view). */
function lineSpan(content: string, match: Match): { start: number; end: number } {
  return { start: match.start, end: Math.max(match.end, lineEnd(content, match.start)) };
}

function findQueryWord(
  content: string,
  from: number,
  to: number,
  words: readonly string[],
): { start: number; end: number } | undefined {
  const line = content.slice(from, to).toLowerCase();
  let best: { start: number; end: number } | undefined;
  for (const word of words) {
    const needle = word.trim().toLowerCase();
    if (needle.length < 2) continue;
    const index = line.indexOf(needle);
    if (index !== -1 && (!best || from + index < best.start)) {
      best = { start: from + index, end: from + index + needle.length };
    }
  }
  return best;
}

// ── Lines and headings ─────────────────────────────────────────────────────────────

function lineEnd(content: string, offset: number): number {
  const newline = content.indexOf('\n', offset);
  const end = newline === -1 ? content.length : newline;
  return content[end - 1] === '\r' ? end - 1 : end;
}

function lineAt(content: string, offset: number): string {
  return content.slice(offset, lineEnd(content, offset));
}

/** Last heading line of a stored heading path ("# A > ## B" → "## B"). */
function lastHeading(headingPath: string | null): string | null {
  if (!headingPath) return null;
  const parts = headingPath.split(' > ');
  return parts[parts.length - 1]?.trim() || null;
}

function headingKey(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

function sameHeading(line: string, heading: string): boolean {
  return headingKey(line) === headingKey(heading);
}

interface Section {
  /** Offset of the heading line. */
  start: number;
  /** Offset of the next heading line (any level), or the end of the text. */
  end: number;
}

/**
 * Sections whose heading chain equals `headingPath`, found with the engine's own rules
 * (ATX headings, fenced code skipped, a heading clears all deeper levels).
 */
function findSections(content: string, base: number, headingPath: string): Section[] {
  const wanted = headingKey(headingPath);
  const wantedText = headingTextKey(headingPath);
  const slots: Array<string | null> = [null, null, null, null, null, null];
  const sections: Section[] = [];
  let open: Section | null = null;
  let inFence = false;
  let pos = base;
  while (pos <= content.length) {
    const end = content.indexOf('\n', pos);
    const lineStop = end === -1 ? content.length : end;
    const line = content.slice(pos, lineStop).replace(/\r$/, '');
    if (/^(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
    } else if (!inFence) {
      const match = /^(#{1,6})\s+/.exec(line);
      if (match) {
        if (open) {
          open.end = pos;
          open = null;
        }
        const level = match[1]!.length;
        slots[level - 1] = line;
        for (let i = level; i < 6; i++) slots[i] = null;
        const chain = slots.filter((s): s is string => s !== null).join(' > ');
        if (headingKey(chain) === wanted || headingTextKey(chain) === wantedText) {
          open = { start: pos, end: content.length };
          sections.push(open);
        }
      }
    }
    if (end === -1) break;
    pos = end + 1;
  }
  return sections;
}

/** Heading path compared by heading text only (no "#" markers, no case). */
function headingTextKey(path: string): string {
  return path
    .split(' > ')
    .map((part) => headingKey(part.replace(/^#{1,6}\s+/, '')).toLowerCase())
    .join(' > ');
}

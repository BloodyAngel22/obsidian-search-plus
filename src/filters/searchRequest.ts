import type { SearchOptions } from '../ipc';
import {
  applyCustomPostfixes,
  applyDefaultFilters,
  parseQuery,
  type CustomPostfix,
  type SimilarTarget,
} from '../ui/queryParser';
import { toEngineFilters } from './filterState';
import type { FilterRow } from './types';

type SearchMode = 'hybrid' | 'semantic' | 'fulltext' | 'title';

export interface SearchRequestInput {
  rawQuery: string;
  /** Mode chosen in the UI; a mode operator typed in the query wins. */
  mode: SearchMode;
  rows: readonly FilterRow[];
  customPostfixes: CustomPostfix[];
  defaultSearchFilters: string;
  /** Resolves `@similar` to a note path; null when there is no target. */
  resolveSimilar: (target: SimilarTarget) => string | null;
  limit?: number;
  threshold?: number;
  snippetLength: number;
  anchors: boolean;
  /** Page size for metadata-only searches. */
  pageSize: number;
}

type SearchRequestKind =
  /** Nothing to search: each view keeps its own empty-query behaviour. */
  | 'empty'
  /** `@similar` with no note to compare against. */
  | 'similar-unavailable'
  /** No text, only filters: one exact, paginated metadata query. */
  | 'metadata'
  /** Ranked text or similar-note search (filters still apply inside retrieval). */
  | 'ranked';

export interface SearchRequest {
  kind: SearchRequestKind;
  /** Text actually sent to the engine. */
  query: string;
  mode: SearchMode;
  rerank: boolean;
  notePath: string | null;
  options: SearchOptions;
  /** True when visual filters are included (engine capabilities must be checked). */
  usesStructuredFilters: boolean;
  /** Words to highlight in previews. */
  queryWords: string[];
  /** Identity of the request without paging: same key → same result set. */
  key: string;
}

/**
 * The single place that turns UI state into an engine request, shared by SearchModal
 * and SearchPanelView. Text, typed operators, default filters, visual filters and
 * paging are kept apart here; legacy operators and visual filters are both sent and
 * the engine ANDs them, so neither group is ever silently dropped.
 */
export function buildSearchRequest(input: SearchRequestInput): SearchRequest {
  const filters = toEngineFilters(input.rows);
  const trimmed = input.rawQuery.trim();
  const base = {
    mode: input.mode,
    rerank: false,
    notePath: null,
    options: {},
    usesStructuredFilters: false,
    queryWords: [],
  };
  if (!trimmed && !filters) {
    return { ...base, kind: 'empty', query: '', key: 'empty' };
  }

  const { query: parsedQuery, overrides } = parseQuery(
    applyDefaultFilters(
      applyCustomPostfixes(trimmed, input.customPostfixes),
      input.defaultSearchFilters,
    ),
  );
  const mode = overrides.mode ?? input.mode;
  const rerank = overrides.rerank ?? false;
  const notePath = overrides.similar ? input.resolveSimilar(overrides.similar) : null;
  if (overrides.similar && !notePath) {
    return { ...base, mode, kind: 'similar-unavailable', query: '', key: 'similar-unavailable' };
  }

  const hasLegacyFilters =
    overrides.tag !== undefined ||
    overrides.scope !== undefined ||
    overrides.frontmatter !== undefined;
  const isMetadata = !parsedQuery && !notePath && (filters !== null || hasLegacyFilters);
  if (!parsedQuery && !notePath && !isMetadata) {
    return { ...base, mode, kind: 'empty', query: '', key: 'empty' };
  }

  const options: SearchOptions = {
    mode,
    ...(notePath && { notePath }),
    ...(overrides.tag !== undefined && { tag: overrides.tag }),
    ...(overrides.scope !== undefined && { scope: overrides.scope }),
    ...(overrides.frontmatter !== undefined && { frontmatter: overrides.frontmatter }),
    ...(overrides.rerank !== undefined && { rerank: overrides.rerank }),
    ...(filters && { filters }),
  };
  if (isMetadata) {
    options.limit = overrides.limit ?? input.pageSize;
    options.snippetLength = 0;
  } else {
    const limit = overrides.limit ?? input.limit;
    const threshold = overrides.threshold ?? input.threshold;
    if (limit !== undefined) options.limit = limit;
    if (threshold !== undefined && threshold > 0) options.threshold = threshold;
    options.snippetLength = input.snippetLength;
    options.anchors = input.anchors;
  }

  // With a notePath the free text is never sent, so it must not be highlighted either.
  const query = notePath ? '' : parsedQuery;
  const queryWords = query
    .split(/\s+/)
    .map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length >= 2);

  return {
    kind: isMetadata ? 'metadata' : 'ranked',
    query,
    mode,
    rerank,
    notePath,
    options,
    usesStructuredFilters: filters !== null,
    queryWords,
    key: JSON.stringify([query, options]),
  };
}

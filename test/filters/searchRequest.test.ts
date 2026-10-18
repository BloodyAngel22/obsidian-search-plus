import { describe, expect, it } from 'vitest';
import { buildSearchRequest, type SearchRequestInput } from '../../src/filters/searchRequest';
import type { FilterRow } from '../../src/filters/types';

const activeRow: FilterRow = { id: 'r1', field: 'projects', operator: 'IN', values: ['alpha'] };
const incompleteRow: FilterRow = { id: 'r2', field: 'type', operator: 'IN', values: [] };

function input(overrides: Partial<SearchRequestInput>): SearchRequestInput {
  return {
    rawQuery: '',
    mode: 'hybrid',
    rows: [],
    customPostfixes: [],
    defaultSearchFilters: '',
    resolveSimilar: () => 'active.md',
    limit: 20,
    threshold: 0,
    snippetLength: 400,
    anchors: true,
    pageSize: 50,
    ...overrides,
  };
}

describe('buildSearchRequest', () => {
  it('is empty without text and without complete filters', () => {
    expect(buildSearchRequest(input({})).kind).toBe('empty');
    expect(buildSearchRequest(input({ rows: [incompleteRow] })).kind).toBe('empty');
  });

  it('builds a metadata-only request for filters without text', () => {
    const request = buildSearchRequest(input({ rows: [activeRow, incompleteRow] }));
    expect(request.kind).toBe('metadata');
    expect(request.query).toBe('');
    expect(request.usesStructuredFilters).toBe(true);
    expect(request.options.limit).toBe(50);
    expect(request.options.filters?.conditions).toEqual([
      { field: 'projects', operator: 'IN', values: ['alpha'] },
    ]);
  });

  it('sends text, typed operators and visual filters together (AND in the engine)', () => {
    const request = buildSearchRequest(
      input({ rawQuery: 'redis stream status:done #pkm', rows: [activeRow] }),
    );
    expect(request.kind).toBe('ranked');
    expect(request.query).toBe('redis stream');
    expect(request.options.frontmatter).toBe('status:done');
    expect(request.options.tag).toBe('pkm');
    expect(request.options.filters?.conditions).toHaveLength(1);
    expect(request.options.limit).toBe(20);
  });

  it('lets a typed mode override the UI mode', () => {
    const request = buildSearchRequest(input({ rawQuery: 'title: redis', mode: 'semantic' }));
    expect(request.mode).toBe('title');
    expect(request.options.mode).toBe('title');
  });

  it('keeps legacy filter-only queries working without visual filters', () => {
    const request = buildSearchRequest(input({ rawQuery: 'status:done' }));
    expect(request.kind).toBe('metadata');
    expect(request.usesStructuredFilters).toBe(false);
    expect(request.options.frontmatter).toBe('status:done');
  });

  it('includes filters in the request key', () => {
    const a = buildSearchRequest(input({ rawQuery: 'x', rows: [activeRow] }));
    const b = buildSearchRequest(
      input({ rawQuery: 'x', rows: [{ ...activeRow, values: ['beta'] }] }),
    );
    expect(a.key).not.toBe(b.key);
  });

  it('reports a missing @similar target', () => {
    const request = buildSearchRequest(input({ rawQuery: '@sim', resolveSimilar: () => null }));
    expect(request.kind).toBe('similar-unavailable');
  });

  it('applies filters to @similar lookups without sending the free text', () => {
    const request = buildSearchRequest(input({ rawQuery: 'ignored @sim', rows: [activeRow] }));
    expect(request.kind).toBe('ranked');
    expect(request.query).toBe('');
    expect(request.options.notePath).toBe('active.md');
    expect(request.options.filters).toBeDefined();
  });
});

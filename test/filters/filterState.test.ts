import { describe, expect, it } from 'vitest';
import {
  formatScalar,
  hasActiveFilters,
  normalizeFilterState,
  parseTypedInput,
  scalarKey,
  toEngineFilters,
  validateRow,
} from '../../src/filters/filterState';
import type { FilterRow } from '../../src/filters/types';

const row = (overrides: Partial<FilterRow>): FilterRow => ({
  id: 'r1',
  field: 'projects',
  operator: 'IN',
  values: [],
  ...overrides,
});

describe('normalizeFilterState', () => {
  it('returns empty state for missing or malformed data', () => {
    expect(normalizeFilterState(undefined)).toEqual({ version: 1, rows: [] });
    expect(normalizeFilterState('x')).toEqual({ version: 1, rows: [] });
    expect(normalizeFilterState({ rows: 'nope' })).toEqual({ version: 1, rows: [] });
  });

  it('keeps valid rows in order, drops invalid ones and dedupes typed values', () => {
    const state = normalizeFilterState({
      rows: [
        {
          id: 'a',
          field: 'projects',
          operator: 'IN',
          values: ['x', 'x', 1, '1', null, { bad: 1 }],
        },
        { id: 'b', field: '', operator: 'IN', values: [] },
        { id: 'c', field: 'type', operator: 'LIKE', values: [] },
        { id: 'a', field: 'status', operator: 'MISSING' },
      ],
    });
    expect(state.rows.map((r) => r.field)).toEqual(['projects', 'status']);
    expect(state.rows[0]!.values).toEqual(['x', 1, '1', null]);
    expect(state.rows[1]!.id).not.toBe('a');
  });
});

describe('validateRow / toEngineFilters', () => {
  it('treats a value operator without values as incomplete and never sends it', () => {
    expect(validateRow(row({})).status).toBe('incomplete');
    expect(toEngineFilters([row({})])).toBeNull();
    expect(hasActiveFilters([row({})])).toBe(false);
  });

  it('marks broken property names invalid', () => {
    expect(validateRow(row({ field: '  ', values: ['x'] })).status).toBe('invalid');
    expect(validateRow(row({ field: 'a\u0001', values: ['x'] })).status).toBe('invalid');
    expect(validateRow(row({ field: 'x'.repeat(300), values: ['x'] })).status).toBe('invalid');
  });

  it('builds the engine contract with typed values and AND across rows', () => {
    const filters = toEngineFilters([
      row({ values: ['mobivion', 'klikmedia'] }),
      row({ id: 'r2', field: 'priority', operator: 'NOT_IN', values: [1] }),
      row({ id: 'r3', field: 'archived', operator: 'MISSING' }),
      row({ id: 'r4', field: 'draft', operator: 'EXISTS' }),
      row({ id: 'r5', field: 'pending' }),
    ]);
    expect(filters).toEqual({
      version: 1,
      operator: 'AND',
      conditions: [
        { field: 'projects', operator: 'IN', values: ['mobivion', 'klikmedia'] },
        { field: 'priority', operator: 'NOT_IN', values: [1] },
        { field: 'archived', operator: 'MISSING' },
        { field: 'draft', operator: 'EXISTS' },
      ],
    });
  });
});

describe('typed values', () => {
  it('keeps number and string identities apart', () => {
    expect(scalarKey(1)).not.toBe(scalarKey('1'));
    expect(scalarKey(true)).not.toBe(scalarKey('true'));
    expect(scalarKey(null)).not.toBe(scalarKey(''));
  });

  it('formats empty and null values visibly', () => {
    expect(formatScalar('')).toBe('""');
    expect(formatScalar(null)).toBe('(null)');
  });

  it('parses typed input from the observed property types', () => {
    expect(parseTypedInput('3', new Set(['number']))).toBe(3);
    expect(parseTypedInput('3', new Set(['number', 'string']))).toBe('3');
    expect(parseTypedInput('true', new Set(['boolean']))).toBe(true);
    expect(parseTypedInput('true', new Set())).toBe('true');
    expect(parseTypedInput('abc', new Set(['number']))).toBe('abc');
  });
});

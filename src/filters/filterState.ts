import {
  FILTER_LIMITS,
  type EngineFilterCondition,
  type EngineStructuredFilters,
  type FilterRow,
  type FilterRowOperator,
  type FilterRowStatus,
  type FilterScalar,
  type MetadataFilterState,
} from './types';

export const EMPTY_FILTER_STATE: MetadataFilterState = { version: 1, rows: [] };

const ROW_OPERATORS = new Set<FilterRowOperator>(['IN', 'NOT_IN', 'EXISTS', 'MISSING']);

// eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function isFilterScalar(value: unknown): value is FilterScalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** Identity of a typed value: `1` and `"1"` are different values. */
export function scalarKey(value: FilterScalar): string {
  return value === null ? 'null:' : `${typeof value}:${String(value)}`;
}

export function operatorNeedsValues(operator: FilterRowOperator): boolean {
  return operator === 'IN' || operator === 'NOT_IN';
}

let rowCounter = 0;
export function newRowId(): string {
  rowCounter += 1;
  return `f${Date.now().toString(36)}${rowCounter.toString(36)}`;
}

/**
 * Validate persisted filter state. Anything malformed is dropped row by row rather
 * than resetting the whole state, and unrelated settings are never touched.
 */
export function normalizeFilterState(raw: unknown): MetadataFilterState {
  if (typeof raw !== 'object' || raw === null) return { version: 1, rows: [] };
  const rowsRaw = (raw as { rows?: unknown }).rows;
  if (!Array.isArray(rowsRaw)) return { version: 1, rows: [] };
  const rows: FilterRow[] = [];
  const ids = new Set<string>();
  for (const entry of rowsRaw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, field, operator, values } = entry as Record<string, unknown>;
    if (typeof field !== 'string' || !field) continue;
    if (typeof operator !== 'string' || !ROW_OPERATORS.has(operator as FilterRowOperator)) continue;
    let rowId = typeof id === 'string' && id ? id : newRowId();
    if (ids.has(rowId)) rowId = newRowId();
    ids.add(rowId);
    const seen = new Set<string>();
    const cleanValues: FilterScalar[] = [];
    for (const value of Array.isArray(values) ? values : []) {
      if (!isFilterScalar(value)) continue;
      const key = scalarKey(value);
      if (seen.has(key)) continue;
      seen.add(key);
      cleanValues.push(value);
    }
    rows.push({ id: rowId, field, operator: operator as FilterRowOperator, values: cleanValues });
    if (rows.length >= FILTER_LIMITS.maxConditions) break;
  }
  return { version: 1, rows };
}

export interface RowValidation {
  status: FilterRowStatus;
  message?: string;
}

export function validateRow(row: FilterRow): RowValidation {
  if (!row.field.trim()) return { status: 'invalid', message: 'Property name is empty.' };
  if (row.field.length > FILTER_LIMITS.maxFieldLength) {
    return { status: 'invalid', message: 'Property name is too long.' };
  }
  if (CONTROL_CHARS.test(row.field)) {
    return { status: 'invalid', message: 'Property name contains control characters.' };
  }
  if (!operatorNeedsValues(row.operator)) return { status: 'active' };
  if (row.values.length === 0) return { status: 'incomplete', message: 'Select a value.' };
  if (row.values.length > FILTER_LIMITS.maxValues) {
    return { status: 'invalid', message: `Select at most ${FILTER_LIMITS.maxValues} values.` };
  }
  if (row.values.some((v) => typeof v === 'string' && v.length > FILTER_LIMITS.maxStringLength)) {
    return { status: 'invalid', message: 'A value is too long.' };
  }
  return { status: 'active' };
}

/** Conditions for the engine. Incomplete and invalid rows never restrict a search. */
export function toEngineFilters(rows: readonly FilterRow[]): EngineStructuredFilters | null {
  const conditions: EngineFilterCondition[] = [];
  for (const row of rows) {
    if (validateRow(row).status !== 'active') continue;
    if (row.operator === 'EXISTS' || row.operator === 'MISSING') {
      conditions.push({ field: row.field, operator: row.operator });
    } else {
      conditions.push({ field: row.field, operator: row.operator, values: [...row.values] });
    }
    if (conditions.length >= FILTER_LIMITS.maxConditions) break;
  }
  return conditions.length > 0 ? { version: 1, operator: 'AND', conditions } : null;
}

export function hasActiveFilters(rows: readonly FilterRow[]): boolean {
  return rows.some((row) => validateRow(row).status === 'active');
}

/** Short text for a value chip: strings as typed, `""` for empty, `(null)` for null. */
export function formatScalar(value: FilterScalar): string {
  if (value === null) return '(null)';
  if (value === '') return '""';
  return String(value);
}

/** Type suffix shown when a value is not a string, so `1` and `"1"` stay distinguishable. */
export function scalarTypeLabel(value: FilterScalar): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? null : typeof value;
}

/**
 * Turn typed text from the value editor into a typed value. The default is a string;
 * a number or boolean is used only when the property is observed with that type and
 * never as a string, so a numeric-looking string property keeps string values.
 */
// eslint-disable-next-line sonarjs/function-return-type -- a typed YAML scalar is inherently string | number | boolean
export function parseTypedInput(text: string, observedTypes: ReadonlySet<string>): FilterScalar {
  const trimmed = text.trim();
  const hasString = observedTypes.has('string');
  if (
    !hasString &&
    observedTypes.has('number') &&
    trimmed !== '' &&
    Number.isFinite(Number(trimmed))
  ) {
    return Number(trimmed);
  }
  if (!hasString && observedTypes.has('boolean') && (trimmed === 'true' || trimmed === 'false')) {
    return trimmed === 'true';
  }
  return text;
}

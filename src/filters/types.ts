/** A YAML scalar as the engine compares it: typed, so 1, "1", true and null differ. */
export type FilterScalar = string | number | boolean | null;

/** One condition of the engine's structured filter contract (version 1). */
export type EngineFilterCondition =
  | { field: string; operator: 'EQ'; value: FilterScalar }
  | { field: string; operator: 'IN' | 'NOT_IN'; values: FilterScalar[] }
  | { field: string; operator: 'EXISTS' | 'MISSING' };

export interface EngineStructuredFilters {
  version: 1;
  operator: 'AND';
  conditions: EngineFilterCondition[];
}

/** Operators offered in the filter row. Several values in one row are ORed (IN). */
export type FilterRowOperator = 'IN' | 'NOT_IN' | 'EXISTS' | 'MISSING';

export const FILTER_ROW_OPERATORS: ReadonlyArray<{ value: FilterRowOperator; label: string }> = [
  { value: 'IN', label: 'is any of' },
  { value: 'NOT_IN', label: 'is none of' },
  { value: 'EXISTS', label: 'exists' },
  { value: 'MISSING', label: 'is missing' },
];

/** One visual filter row. Only serialisable data — persisted in plugin settings. */
export interface FilterRow {
  id: string;
  field: string;
  operator: FilterRowOperator;
  values: FilterScalar[];
}

export interface MetadataFilterState {
  version: 1;
  rows: FilterRow[];
}

/** Limits mirrored from the engine contract, so invalid rows are caught in the UI. */
export const FILTER_LIMITS = {
  maxConditions: 32,
  maxValues: 256,
  maxFieldLength: 256,
  maxStringLength: 2048,
} as const;

export type FilterRowStatus =
  /** Added, but not restricting results yet (e.g. no value selected). */
  | 'incomplete'
  /** Sent with every search. */
  | 'active'
  /** Cannot be sent; see the message. */
  | 'invalid';

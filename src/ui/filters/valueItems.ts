import {
  formatScalar,
  parseTypedInput,
  scalarKey,
  scalarTypeLabel,
} from '../../filters/filterState';
import type { MetadataCatalog } from '../../filters/metadataCatalog';
import type { MetadataMenuHint } from '../../filters/metadataMenu';
import type { FilterRow, FilterScalar } from '../../filters/types';
import type { ListItem, ListPage } from './SearchableList';

const VALUE_RENDER_LIMIT = 50;
const PROPERTY_RENDER_LIMIT = 60;

export interface ValuePage extends ListPage {
  /** Typed value behind each item id. */
  valueById: Map<string, FilterScalar>;
}

function noteCountText(count: number): string {
  return count === 1 ? '1 note' : `${count} notes`;
}

/**
 * Items for one row's value list: the row's selected values first (kept even when no
 * note has them any more), then observed values, then Metadata Menu options, and a
 * "use exact value" entry for text that matches nothing. Bounded by VALUE_RENDER_LIMIT.
 */
export function buildValuePage(
  catalog: MetadataCatalog,
  row: FilterRow,
  query: string,
  hint: MetadataMenuHint | null,
): ValuePage {
  const property = catalog.getProperty(row.field);
  const observedTypes = new Set<string>(property?.valueTypes ?? []);
  const needle = query.trim().toLowerCase();
  const items: ListItem[] = [];
  const valueById = new Map<string, FilterScalar>();
  const selected = new Set(row.values.map(scalarKey));
  const matches = (value: FilterScalar) =>
    !needle || formatScalar(value).toLowerCase().includes(needle);

  const push = (value: FilterScalar, detail?: string, muted = false, title?: string) => {
    const id = scalarKey(value);
    if (valueById.has(id)) return;
    valueById.set(id, value);
    items.push({
      id,
      label: formatScalar(value),
      badge: scalarTypeLabel(value) ?? undefined,
      detail,
      checked: selected.has(id),
      muted,
      title,
    });
  };

  if (query.trim() !== '') {
    const typed = parseTypedInput(query.trim(), observedTypes);
    if (!valueById.has(scalarKey(typed)) && catalog.valueCount(row.field, typed) === 0) {
      push(typed, 'use exact value', false, 'Match this exact value even if no note has it yet');
    }
  }

  for (const value of row.values) {
    if (!matches(value)) continue;
    const count = catalog.valueCount(row.field, value);
    push(
      value,
      count > 0 ? noteCountText(count) : 'no notes now',
      count === 0,
      count === 0
        ? 'No note has this value now. It stays selected until you remove it.'
        : undefined,
    );
  }

  const { values, total } = catalog.searchValues(row.field, query, VALUE_RENDER_LIMIT);
  for (const info of values) push(info.value, noteCountText(info.count));

  if (observedTypes.size === 1 && observedTypes.has('boolean')) {
    for (const value of [true, false]) if (matches(value)) push(value, noteCountText(0));
  }

  for (const option of hint?.options ?? []) {
    if (items.length >= VALUE_RENDER_LIMIT + row.values.length + 1) break;
    if (matches(option)) push(option, 'defined in Metadata Menu');
  }

  const hiddenCount = Math.max(0, total - values.length);
  return { items, hiddenCount, valueById };
}

export function buildPropertyPage(
  catalog: MetadataCatalog,
  query: string,
  activeFields: ReadonlySet<string>,
): ListPage {
  const all = catalog.searchProperties(query, Number.MAX_SAFE_INTEGER);
  const shown = all.slice(0, PROPERTY_RENDER_LIMIT);
  const items: ListItem[] = shown.map((property) => {
    const isList = property.shapes.has('list');
    const variants = property.caseVariants.length
      ? `Also used with different case: ${property.caseVariants.join(', ')}`
      : undefined;
    return {
      id: `p:${property.name}`,
      label: property.name,
      badge: isList ? 'list' : undefined,
      detail: noteCountText(property.noteCount),
      checked: activeFields.has(property.name) ? true : undefined,
      title: variants,
    };
  });
  const trimmed = query.trim();
  if (trimmed && !all.some((p) => p.name === trimmed)) {
    items.push({
      id: `p:${trimmed}`,
      label: trimmed,
      detail: 'not found in vault',
      muted: true,
      title: 'Filter by this exact property name even though no note uses it now',
    });
  }
  return { items, hiddenCount: Math.max(0, all.length - shown.length) };
}

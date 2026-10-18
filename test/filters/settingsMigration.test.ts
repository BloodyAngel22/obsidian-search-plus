import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings, type HybridSearchSettings } from '../../src/settings';

describe('metadata filter settings migration', () => {
  it('gives old installations empty filters without touching other settings', () => {
    const old = { ...DEFAULT_SETTINGS, defaultMode: 'fulltext', searchPanelLimit: 42 } as Record<
      string,
      unknown
    >;
    delete old.metadataFilters;
    const normalized = normalizeSettings(old as unknown as HybridSearchSettings);
    expect(normalized.metadataFilters).toEqual({ version: 1, rows: [] });
    expect(normalized.defaultMode).toBe('fulltext');
    expect(normalized.searchPanelLimit).toBe(42);
  });

  it('keeps valid saved filters and repairs corrupt ones', () => {
    const normalized = normalizeSettings({
      ...DEFAULT_SETTINGS,
      metadataFilters: {
        version: 1,
        rows: [
          { id: 'a', field: 'type', operator: 'IN', values: ['learn'] },
          { id: 'b', field: 'bad', operator: 'NOPE' as never, values: [] },
        ],
      },
    });
    expect(normalized.metadataFilters.rows).toEqual([
      { id: 'a', field: 'type', operator: 'IN', values: ['learn'] },
    ]);
  });
});

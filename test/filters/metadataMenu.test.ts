import { describe, expect, it, vi } from 'vitest';
import { MetadataMenuAdapter } from '../../src/filters/metadataMenu';
import { FakeVault } from './fakeVault';

function adapterWith(plugins: unknown) {
  const vault = new FakeVault();
  vault.set('a.md', { status: 'open' });
  vault.set('b.md', { status: 'done' });
  vault.plugins = plugins;
  return new MetadataMenuAdapter(vault.app());
}

function registry(api: unknown, enabled = true) {
  return {
    enabledPlugins: new Set(enabled ? ['metadata-menu'] : []),
    getPlugin: (id: string) => (id === 'metadata-menu' ? { api } : null),
  };
}

describe('MetadataMenuAdapter', () => {
  it('falls back to the generic editor when the plugin is absent', async () => {
    const adapter = adapterWith(undefined);
    expect(adapter.isAvailable()).toBe(false);
    expect(await adapter.getHint('status', ['a.md'])).toEqual({
      editor: 'generic',
      options: [],
      reason: 'unavailable',
    });
  });

  it('ignores a disabled plugin', async () => {
    const api = { namedFileFields: vi.fn() };
    const adapter = adapterWith(registry(api, false));
    expect(adapter.isAvailable()).toBe(false);
    expect((await adapter.getHint('status', ['a.md'])).reason).toBe('unavailable');
    expect(api.namedFileFields).not.toHaveBeenCalled();
  });

  it('ignores an API without the public methods (unsupported version)', () => {
    expect(adapterWith(registry({ somethingElse: true })).isAvailable()).toBe(false);
  });

  it('uses agreeing Select definitions as hints, with options as suggestions only', async () => {
    const api = {
      namedFileFields: vi.fn().mockResolvedValue({
        status: { type: 'Select', options: { valuesList: { 1: 'open', 2: 'done' } } },
      }),
    };
    const hint = await adapterWith(registry(api)).getHint('status', ['a.md', 'b.md']);
    expect(hint).toEqual({ editor: 'select', options: ['open', 'done'] });
  });

  it('falls back on conflicting definitions across notes / FileClasses', async () => {
    const api = {
      namedFileFields: vi
        .fn()
        .mockResolvedValueOnce({ status: { type: 'Select', options: {} } })
        .mockResolvedValueOnce({ status: { type: 'Multi', options: {} } }),
    };
    const hint = await adapterWith(registry(api)).getHint('status', ['a.md', 'b.md']);
    expect(hint).toEqual({ editor: 'generic', options: [], reason: 'conflict' });
  });

  it('survives API exceptions', async () => {
    const api = { namedFileFields: vi.fn().mockRejectedValue(new Error('boom')) };
    const hint = await adapterWith(registry(api)).getHint('status', ['a.md']);
    expect(hint).toEqual({ editor: 'generic', options: [], reason: 'error' });
  });

  it('survives a throwing plugin registry', () => {
    const broken = {
      get enabledPlugins(): Set<string> {
        throw new Error('nope');
      },
    };
    expect(adapterWith(broken).isAvailable()).toBe(false);
  });

  it('reports unknown field types and missing definitions as generic', async () => {
    const unknownType = {
      namedFileFields: vi.fn().mockResolvedValue({ status: { type: 'Lookup' } }),
    };
    expect((await adapterWith(registry(unknownType)).getHint('status', ['a.md'])).reason).toBe(
      'unknown-type',
    );
    const none = { namedFileFields: vi.fn().mockResolvedValue({}) };
    expect((await adapterWith(registry(none)).getHint('status', ['a.md'])).reason).toBe(
      'no-definition',
    );
  });

  it('re-keys fileFields results by field name for older API versions', async () => {
    const api = {
      fileFields: vi.fn().mockResolvedValue({ abc123: { name: 'status', type: 'Boolean' } }),
    };
    expect(await adapterWith(registry(api)).getHint('status', ['a.md'])).toEqual({
      editor: 'boolean',
      options: [],
    });
  });

  it('caches hints per field until invalidated', async () => {
    const api = { namedFileFields: vi.fn().mockResolvedValue({ status: { type: 'Boolean' } }) };
    const adapter = adapterWith(registry(api));
    await adapter.getHint('status', ['a.md']);
    await adapter.getHint('status', ['a.md']);
    expect(api.namedFileFields).toHaveBeenCalledTimes(1);
    adapter.invalidate();
    await adapter.getHint('status', ['a.md']);
    expect(api.namedFileFields).toHaveBeenCalledTimes(2);
  });
});

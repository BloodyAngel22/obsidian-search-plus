import { describe, expect, it, vi } from 'vitest';
import { EngineCapabilityCache } from '../../src/filters/engineCompat';
import { SearchCoordinator, type CoordinatorClient } from '../../src/filters/searchCoordinator';
import { buildSearchRequest } from '../../src/filters/searchRequest';
import type { FilterRow } from '../../src/filters/types';
import type { SearchResponse, SearchResult } from '../../src/ipc';

const MODERN = {
  apiVersion: 2,
  capabilities: ['structuredFiltersV1', 'metadataOnlyPagination', 'searchMeta'],
};

function request(values: string[], rawQuery = '') {
  const rows: FilterRow[] = [{ id: 'r', field: 'projects', operator: 'IN', values }];
  return buildSearchRequest({
    rawQuery,
    mode: 'hybrid',
    rows,
    customPostfixes: [],
    defaultSearchFilters: '',
    resolveSimilar: () => null,
    snippetLength: 0,
    anchors: false,
    pageSize: 50,
  });
}

function result(path: string): SearchResult {
  return { path, title: path, score: 1, tags: [], aliases: [] };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('SearchCoordinator', () => {
  it('drops an older response that arrives after a newer request', async () => {
    const first = deferred<SearchResponse>();
    const second = deferred<SearchResponse>();
    const pending = [first, second];
    const client: CoordinatorClient = {
      search: vi.fn(),
      getCapabilities: vi.fn().mockResolvedValue(MODERN),
      searchWithMeta: vi.fn(() => pending.shift()!.promise),
    };
    const coordinator = new SearchCoordinator(() => client, new EngineCapabilityCache());
    const older = coordinator.run(request(['alpha']));
    await Promise.resolve();
    await Promise.resolve();
    const newer = coordinator.run(request(['beta']));
    await Promise.resolve();
    await Promise.resolve();
    second.resolve({ results: [result('beta.md')] });
    first.resolve({ results: [result('alpha.md')] });
    expect(await newer).toEqual({ status: 'ok', results: [result('beta.md')], meta: undefined });
    expect(await older).toEqual({ status: 'stale' });
  });

  it('refuses to search with filters on an engine without the capabilities', async () => {
    const client: CoordinatorClient = {
      search: vi.fn(),
      getCapabilities: vi.fn().mockResolvedValue({ apiVersion: 1, capabilities: [] }),
      searchWithMeta: vi.fn(),
    };
    const coordinator = new SearchCoordinator(() => client, new EngineCapabilityCache());
    const outcome = await coordinator.run(request(['alpha'], 'redis'));
    expect(outcome.status).toBe('incompatible');
    expect((outcome as { message: string }).message).toMatch(/Update Search Plus Engine/);
    expect(client.searchWithMeta).not.toHaveBeenCalled();
    expect(client.search).not.toHaveBeenCalled();
  });

  it('reports a broken metadata index as incompatible', async () => {
    const client: CoordinatorClient = {
      search: vi.fn(),
      getCapabilities: vi.fn().mockResolvedValue({
        apiVersion: 2,
        capabilities: ['searchMeta'],
        propertyIndexError: 'migration failed',
      }),
      searchWithMeta: vi.fn(),
    };
    const outcome = await new SearchCoordinator(() => client, new EngineCapabilityCache()).run(
      request(['alpha']),
    );
    expect(outcome).toEqual({
      status: 'incompatible',
      message: 'Metadata filters are unavailable: migration failed',
    });
  });

  it('surfaces engine errors instead of empty results, and never retries without filters', async () => {
    const client: CoordinatorClient = {
      search: vi.fn(),
      getCapabilities: vi.fn().mockResolvedValue(MODERN),
      searchWithMeta: vi.fn().mockRejectedValue(new Error('Invalid filters: boom')),
    };
    const outcome = await new SearchCoordinator(() => client, new EngineCapabilityCache()).run(
      request(['alpha']),
    );
    expect(outcome).toEqual({ status: 'error', message: 'Invalid filters: boom' });
    expect(client.search).not.toHaveBeenCalled();
  });

  it('uses the legacy search path when no visual filters are active', async () => {
    const client: CoordinatorClient = {
      search: vi.fn().mockResolvedValue([result('a.md')]),
      getCapabilities: vi.fn(),
    };
    const outcome = await new SearchCoordinator(() => client, new EngineCapabilityCache()).run(
      request([], 'redis'),
    );
    expect(outcome.status).toBe('ok');
    expect(client.getCapabilities).not.toHaveBeenCalled();
  });

  it('checks capabilities once per client and passes the page offset', async () => {
    const client: CoordinatorClient = {
      search: vi.fn(),
      getCapabilities: vi.fn().mockResolvedValue(MODERN),
      searchWithMeta: vi.fn().mockResolvedValue({ results: [] }),
    };
    const coordinator = new SearchCoordinator(() => client, new EngineCapabilityCache());
    await coordinator.run(request(['alpha']));
    await coordinator.run(request(['alpha']), 50);
    expect(client.getCapabilities).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.searchWithMeta!).mock.calls[1]![1]).toMatchObject({ offset: 50 });
  });

  it('shares one round-trip between identical concurrent requests', async () => {
    const pending = deferred<SearchResponse>();
    const client: CoordinatorClient = {
      search: vi.fn(),
      getCapabilities: vi.fn().mockResolvedValue(MODERN),
      searchWithMeta: vi.fn(() => pending.promise),
    };
    const coordinator = new SearchCoordinator(() => client, new EngineCapabilityCache());
    const first = coordinator.run(request(['alpha']));
    const second = coordinator.run(request(['alpha']));
    await new Promise((r) => setTimeout(r, 0));
    pending.resolve({ results: [result('x.md')] });
    expect(await first).toEqual({ status: 'stale' });
    expect((await second).status).toBe('ok');
    expect(client.searchWithMeta).toHaveBeenCalledTimes(1);
  });
});

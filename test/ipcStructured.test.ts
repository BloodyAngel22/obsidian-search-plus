// @vitest-environment node
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockStdin = { write: vi.fn() };
const mockStdout = new EventEmitter();
const mockProc = new EventEmitter() as EventEmitter & {
  stdin: typeof mockStdin;
  stdout: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  killed: boolean;
};
mockProc.stdin = mockStdin;
mockProc.stdout = mockStdout;
mockProc.kill = vi.fn();
mockProc.exitCode = null;
mockProc.killed = false;

vi.mock('child_process', () => ({ spawn: vi.fn(() => mockProc) }));

import { requestUrl } from 'obsidian';
import { HttpSearchClient, parseEngineCapabilities, SearchClient } from '../src/ipc';

type RequestUrlResponse = Awaited<ReturnType<typeof requestUrl>>;

function emitLine(value: unknown) {
  mockStdout.emit('data', Buffer.from(JSON.stringify(value) + '\n', 'utf8'));
}

function lastRequest(): Record<string, unknown> {
  const calls = mockStdin.write.mock.calls;
  return JSON.parse(String(calls[calls.length - 1]![0])) as Record<string, unknown>;
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const filters = {
  version: 1 as const,
  operator: 'AND' as const,
  conditions: [{ field: 'type', operator: 'EQ' as const, value: 'learn' }],
};

describe('SearchClient structured requests', () => {
  let client: SearchClient;
  beforeEach(() => {
    mockStdin.write.mockReset();
    mockStdout.removeAllListeners();
    mockProc.removeAllListeners();
    client = new SearchClient('/usr/bin/ohs', '/vault');
    emitLine({ ready: true });
  });
  afterEach(() => client.dispose());

  it('sends filters and offset and returns results with meta', async () => {
    const pending = client.searchWithMeta('', { filters, offset: 50, limit: 50 });
    await flush();
    const request = lastRequest();
    expect(request.options).toMatchObject({ filters, offset: 50, limit: 50 });
    emitLine({
      id: request.id,
      results: [{ path: 'a.md' }],
      meta: { total: 99, totalExact: true },
    });
    await expect(pending).resolves.toEqual({
      results: [{ path: 'a.md' }],
      meta: { total: 99, totalExact: true },
    });
  });

  it('rejects on engine errors instead of resolving an empty list', async () => {
    const pending = client.searchWithMeta('x', { filters });
    await flush();
    emitLine({
      id: lastRequest().id,
      error: 'Invalid filters: conditions.0.field must not be empty',
    });
    await expect(pending).rejects.toThrow(/Invalid filters/);
  });

  it('reads capabilities from the capabilities action', async () => {
    const pending = client.getCapabilities();
    await flush();
    expect(lastRequest().action).toBe('capabilities');
    emitLine({
      id: lastRequest().id,
      capabilities: { apiVersion: 2, capabilities: ['structuredFiltersV1'] },
    });
    await expect(pending).resolves.toEqual({
      apiVersion: 2,
      capabilities: ['structuredFiltersV1'],
    });
  });

  it('treats engines without the capabilities action as legacy', async () => {
    const pending = client.getCapabilities();
    await flush();
    emitLine({ id: lastRequest().id, error: 'unknown action: capabilities' });
    await expect(pending).resolves.toEqual({ apiVersion: 1, capabilities: [] });
  });

  it('rejects pending structured searches when the server restarts', async () => {
    const pending = client.searchWithMeta('x', { filters });
    await flush();
    client.dispose();
    await expect(pending).rejects.toThrow(/restarted/);
  });
});

describe('parseEngineCapabilities', () => {
  it('reads reports defensively', () => {
    expect(parseEngineCapabilities(undefined)).toEqual({ apiVersion: 1, capabilities: [] });
    expect(parseEngineCapabilities({ apiVersion: 2, capabilities: ['a', 3] })).toEqual({
      apiVersion: 2,
      capabilities: ['a'],
    });
    expect(
      parseEngineCapabilities({ apiVersion: 2, capabilities: [], propertyIndexError: 'x' }),
    ).toEqual({ apiVersion: 2, capabilities: [], propertyIndexError: 'x' });
  });
});

describe('HttpSearchClient structured requests', () => {
  const requestUrlMock = vi.mocked(requestUrl);
  afterEach(() => requestUrlMock.mockReset());

  function ok(body: unknown, headers: Record<string, string> = {}): RequestUrlResponse {
    return {
      status: 200,
      headers,
      text: JSON.stringify(body),
      json: body,
    } as unknown as RequestUrlResponse;
  }

  function primeSession(responses: RequestUrlResponse[]) {
    const queue = [
      ok({ ok: true }),
      ok({ jsonrpc: '2.0', id: 1, result: {} }, { 'mcp-session-id': 's1' }),
      ...responses,
    ];
    const bodies: unknown[] = [];
    requestUrlMock.mockImplementation(((req: { body?: string }) => {
      if (req.body) bodies.push(JSON.parse(req.body));
      return Promise.resolve(queue.shift()!);
    }) as never);
    return bodies;
  }

  it('sends filters to the search tool and returns meta', async () => {
    const bodies = primeSession([
      ok({
        jsonrpc: '2.0',
        id: 2,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ results: [], meta: { total: 0, totalExact: true } }),
            },
          ],
        },
      }),
    ]);
    const client = new HttpSearchClient('127.0.0.1', 3939);
    const response = await client.searchWithMeta('', { filters, offset: 10 });
    expect(response.meta).toEqual({ total: 0, totalExact: true });
    const call = bodies[bodies.length - 1] as { params: { arguments: Record<string, unknown> } };
    expect(call.params.arguments).toMatchObject({ filters, offset: 10 });
  });

  it('throws tool errors without failing over to another server', async () => {
    primeSession([
      ok({
        jsonrpc: '2.0',
        id: 2,
        result: { isError: true, content: [{ type: 'text', text: 'Invalid filters: bad' }] },
      }),
    ]);
    const onStatusChange = vi.fn();
    const client = new HttpSearchClient('127.0.0.1', 3939, {
      fallback: { host: '127.0.0.1', port: 4949 },
      onStatusChange,
    });
    await expect(client.searchWithMeta('x', { filters })).rejects.toThrow('Invalid filters: bad');
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('reports servers without capabilities in status as legacy', async () => {
    primeSession([
      ok({
        jsonrpc: '2.0',
        id: 2,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ total: 1, failed_chunks: 0 }) }],
        },
      }),
    ]);
    const client = new HttpSearchClient('127.0.0.1', 3939);
    await expect(client.getCapabilities()).resolves.toEqual({ apiVersion: 1, capabilities: [] });
  });

  it('reads capabilities from the status tool', async () => {
    primeSession([
      ok({
        jsonrpc: '2.0',
        id: 2,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                total: 1,
                failed_chunks: 0,
                capabilities: { apiVersion: 2, capabilities: ['structuredFiltersV1'] },
              }),
            },
          ],
        },
      }),
    ]);
    const client = new HttpSearchClient('127.0.0.1', 3939);
    await expect(client.getCapabilities()).resolves.toEqual({
      apiVersion: 2,
      capabilities: ['structuredFiltersV1'],
    });
  });
});

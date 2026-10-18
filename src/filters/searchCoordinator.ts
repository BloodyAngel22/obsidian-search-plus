import type {
  EngineCapabilities,
  SearchMeta,
  SearchOptions,
  SearchResponse,
  SearchResult,
} from '../ipc';
import {
  EngineCapabilityCache,
  incompatibleEngineMessage,
  missingCapabilities,
  REQUIRED_FILTER_CAPABILITIES,
} from './engineCompat';
import type { SearchRequest } from './searchRequest';

export interface CoordinatorClient {
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  searchWithMeta?: (query: string, options?: SearchOptions) => Promise<SearchResponse>;
  getCapabilities?: (timeoutMs?: number) => Promise<EngineCapabilities>;
}

export type SearchOutcome =
  | { status: 'ok'; results: SearchResult[]; meta?: SearchMeta }
  /** A newer request started; this answer must be dropped. */
  | { status: 'stale' }
  | { status: 'error'; message: string }
  /** The engine cannot apply the filters; nothing was searched. */
  | { status: 'incompatible'; message: string };

/**
 * Runs SearchRequests for one view. Each run gets a ticket; only the latest ticket's
 * answer is delivered, so an older, slower response can never overwrite newer results.
 * Requests with visual filters are only sent after the engine confirmed the needed
 * capabilities, and they are never retried without the filters.
 */
export class SearchCoordinator {
  private ticket = 0;
  private inflight = new Map<string, Promise<SearchResponse>>();

  constructor(
    private readonly getClient: () => CoordinatorClient | undefined,
    private readonly capabilities: EngineCapabilityCache,
  ) {}

  /** Invalidate every pending run (e.g. when the query is cleared or the view closes). */
  cancel(): void {
    this.ticket += 1;
  }

  async run(request: SearchRequest, offset = 0): Promise<SearchOutcome> {
    const ticket = ++this.ticket;
    const outcome = await this.execute(request, offset);
    return ticket === this.ticket ? outcome : { status: 'stale' };
  }

  private async execute(request: SearchRequest, offset: number): Promise<SearchOutcome> {
    const client = this.getClient();
    if (!client) return { status: 'error', message: 'Search client not ready.' };
    try {
      if (request.usesStructuredFilters) {
        let caps: EngineCapabilities;
        try {
          caps = await this.capabilities.get(client);
        } catch (error) {
          return {
            status: 'error',
            message: `Could not check engine capabilities: ${errorText(error)}`,
          };
        }
        const missing = missingCapabilities(caps, REQUIRED_FILTER_CAPABILITIES);
        if (missing.length > 0 || caps.propertyIndexError) {
          return { status: 'incompatible', message: incompatibleEngineMessage(caps, missing) };
        }
        if (typeof client.searchWithMeta !== 'function') {
          return {
            status: 'incompatible',
            message: incompatibleEngineMessage(caps, ['searchMeta']),
          };
        }
        const response = await this.dedupe(client, request, offset);
        return { status: 'ok', results: response.results, meta: response.meta };
      }
      const results = await client.search(request.query, request.options);
      return { status: 'ok', results };
    } catch (error) {
      return { status: 'error', message: errorText(error) };
    }
  }

  /** Identical concurrent requests (same filters, text and page) share one round-trip. */
  private dedupe(
    client: CoordinatorClient,
    request: SearchRequest,
    offset: number,
  ): Promise<SearchResponse> {
    const options: SearchOptions = offset > 0 ? { ...request.options, offset } : request.options;
    const key = `${request.key}\u0000${offset}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const pending = client.searchWithMeta!(request.query, options).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, pending);
    return pending;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

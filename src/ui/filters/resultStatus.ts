import type { SearchMeta } from '../../ipc';

/**
 * Status line for a result list. An exact total is shown only when the engine
 * computed one (metadata-only searches); ranked searches state how many results were
 * retrieved, never a guessed vault-wide count.
 */
export function describeResults(shown: number, meta: SearchMeta | undefined): string {
  if (meta?.totalExact && typeof meta.total === 'number') {
    const total = meta.total;
    const noun = total === 1 ? 'note matches' : 'notes match';
    if (total === 0) return 'No notes match these filters.';
    return shown < total ? `${total} ${noun} · showing ${shown}` : `${total} ${noun}`;
  }
  if (shown === 0) return 'No results with these filters.';
  return shown === 1 ? '1 filtered result' : `${shown} filtered results`;
}

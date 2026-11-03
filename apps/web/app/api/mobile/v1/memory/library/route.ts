import {
  listMemoryLibrary,
  listMemoryLibraryFilters,
  type MemoryFilter,
  type MemoryState,
} from '@assistant/application/profile';
import { loadConfig } from '@assistant/config';
import { loadFirestoreMemoryLibrary } from '@/lib/firestore-knowledge';
import {
  createMemoryLibraryDiagnosticContext,
  withMemoryLibraryPhase,
} from '@/lib/memory-library-diagnostics';
import { getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const STATES: MemoryState[] = ['in-use', 'review'];
const FILTERS: MemoryFilter[] = ['all', 'verified', 'untidied'];
const CONNECTIVITY = ['all', 'connected', 'unconnected'] as const;

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * The memory library, paged and filtered.
 *
 * The workspace payload carries the first 80 owner facts for the Memory
 * screen's summary, which meant the phone could not reach the 81st fact at
 * all — not a filtering gap so much as a cap on seeing your own memory. This
 * serves the same query the web library runs, so both clients page and filter
 * the same way.
 */
export async function GET(request: Request): Promise<Response> {
  const diagnostics = createMemoryLibraryDiagnosticContext();
  return withMemoryLibraryPhase(diagnostics, 'overall', async () => {
    if (!(await withMemoryLibraryPhase(diagnostics, 'auth', () => isMobileAuthed(request))))
      return mobileUnauthorized();
    const params = new URL(request.url).searchParams;
    const ageDays = Number(params.get('ageDays'));
    const input = {
      state: pick(params.get('state'), STATES, 'in-use'),
      filter: pick(params.get('filter'), FILTERS, 'all'),
      query: params.get('q')?.slice(0, 200) ?? '',
      page: Math.max(1, Number(params.get('page')) || 1),
      subjectId: params.get('subjectId') || undefined,
      domain: params.get('domain') || undefined,
      source: params.get('source') || undefined,
      ageDays: Number.isFinite(ageDays) && ageDays > 0 ? ageDays : undefined,
      connectivity: pick(params.get('connectivity'), CONNECTIVITY, 'all'),
    };
    const config = await withMemoryLibraryPhase(diagnostics, 'config', () => loadConfig());
    const [library, filters] = await (async () => {
      if (config.PERSISTENCE_DRIVER !== 'firestore')
        return Promise.all([
          withMemoryLibraryPhase(diagnostics, 'list', () => listMemoryLibrary(getDb(), input)),
          withMemoryLibraryPhase(diagnostics, 'filters', () => listMemoryLibraryFilters(getDb())),
        ]);
      return loadFirestoreMemoryLibrary(input, diagnostics);
    })();

    // The same rule the web library applies: a row with no joined contact is the
    // owner's, and so is one whose subject is the owner's own contact. The label
    // alone cannot carry this — an owner fact joins the owner's contact and so
    // arrives with their name, indistinguishable from a fact about someone else.
    const ownerId = filters.subjects.find((subject) => subject.trust === 'owner')?.id ?? null;

    return withMemoryLibraryPhase(diagnostics, 'serialize', () =>
      mobileJson({
        rows: library.rows.map((row) => ({
          id: row.memory.id,
          content: row.memory.content,
          domain: row.memory.domain ?? '',
          ownerConfirmed: row.memory.ownerConfirmed,
          pinned: row.memory.pinned,
          importance: row.memory.importance,
          // The state parameter already decides quarantined-or-not, so the row
          // carries the two things the list actually distinguishes on.
          organized: row.memory.lastConsolidatedAt !== null,
          originTrust: row.memory.originTrust,
          subjectLabel: row.subjectLabel ?? '',
          aboutOwner: row.subjectId === null || row.subjectId === ownerId,
          connectionCount: row.connectionCount,
          projectionStatus: row.projectionStatus,
          createdAt: row.memory.createdAt.toISOString(),
        })),
        total: library.total,
        page: library.page,
        totalPages: library.totalPages,
        subjects: filters.subjects,
        sources: filters.sources,
      }),
    );
  });
}

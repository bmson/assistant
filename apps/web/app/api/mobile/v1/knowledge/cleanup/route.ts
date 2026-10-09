import {
  cleanKnowledgeProjectionOrphans,
  getKnowledgeCleanupFindings,
  retryQuarantinedKnowledgeGraphSources,
} from '@assistant/application';
import { loadConfig } from '@assistant/config';
import {
  getFirestoreKnowledgeCuration,
  getFirestoreKnowledgeWorkspace,
} from '@/lib/firestore-knowledge';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { getDb, getOwnerMemoryCommands } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore')
    return mobileJson({ findings: (await getFirestoreKnowledgeWorkspace().load()).findings });
  return mobileJson({ findings: await getKnowledgeCleanupFindings(getDb()) });
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const mutationBody = await readMobileMutationBody(request, ['action', 'memoryId']);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value as Record<string, unknown> | null;
  const action = typeof body?.action === 'string' ? body.action : '';
  const memoryId = typeof body?.memoryId === 'string' ? body.memoryId : '';
  const curation =
    loadConfig().PERSISTENCE_DRIVER === 'firestore' ? getFirestoreKnowledgeCuration() : null;
  if (action === 'remove-orphans')
    await (curation ? curation.removeOrphanedEntities() : cleanKnowledgeProjectionOrphans(getDb()));
  else if (action === 'retry')
    await (curation
      ? curation.retryBlockedSources()
      : retryQuarantinedKnowledgeGraphSources(getDb()));
  else if (action === 'forget' && memoryId) await getOwnerMemoryCommands().forgetMemory(memoryId);
  else if (action === 'approve' && memoryId)
    await getOwnerMemoryCommands().approveQuarantinedMemory(memoryId);
  else if (action === 'keep' && memoryId) await getOwnerMemoryCommands().restoreMemory(memoryId);
  else return mobileJson({ error: 'invalid cleanup action' }, { status: 400 });
  return mobileJson({ ok: true });
}

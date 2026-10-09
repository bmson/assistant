import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { FirestoreMcpConnectionMutationRepository } from '@assistant/firestore';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import {
  discoverFirestoreMcpConnection,
  getApplication,
  getFirestoreInstallationStore,
} from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid MCP connection id' }, { status: 400 });
  const mutationBody = await readMobileMutationBody(request, ['action']);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value as { action?: unknown } | null;
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    if (body?.action !== 'refresh' && body?.action !== 'enable' && body?.action !== 'disable')
      return mobileJson({ error: 'action must be refresh, enable, or disable' }, { status: 400 });
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
    const store = getFirestoreInstallationStore();
    try {
      const repository = new FirestoreMcpConnectionMutationRepository(
        store,
        config.FIRESTORE_AGENT_ID,
      );
      if (body.action === 'refresh') {
        const discovery = await discoverFirestoreMcpConnection(id);
        return !('status' in discovery)
          ? mobileJson({ error: discovery.error }, { status: 404 })
          : mobileJson(discovery);
      }
      const result = await repository.setEnabled(id, body.action === 'enable');
      if (!result) return mobileJson({ error: 'MCP connection not found.' }, { status: 404 });
      if (body.action === 'enable') {
        const discovery = await discoverFirestoreMcpConnection(id);
        return !('status' in discovery)
          ? mobileJson({ connectionId: id, status: 'error', error: discovery.error })
          : mobileJson(discovery);
      }
      return result
        ? mobileJson(result)
        : mobileJson({ error: 'MCP connection not found.' }, { status: 404 });
    } catch (error) {
      return mobileJson(
        { error: error instanceof Error ? error.message : 'MCP connection could not be updated.' },
        { status: 409 },
      );
    }
  }
  const application = getApplication();
  const result =
    body?.action === 'refresh'
      ? await application.refreshMcpConnection(id)
      : body?.action === 'enable'
        ? await application.setMcpConnectionEnabled(id, true)
        : body?.action === 'disable'
          ? await application.setMcpConnectionEnabled(id, false)
          : null;
  if (!result)
    return mobileJson({ error: 'action must be refresh, enable, or disable' }, { status: 400 });
  return 'error' in result
    ? mobileJson({ error: result.error }, { status: 404 })
    : mobileJson(result);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid MCP connection id' }, { status: 400 });
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
    const store = getFirestoreInstallationStore();
    try {
      const deleted = await new FirestoreMcpConnectionMutationRepository(
        store,
        config.FIRESTORE_AGENT_ID,
      ).delete(id);
      return deleted
        ? mobileJson({ ok: true })
        : mobileJson({ error: 'MCP connection not found.' }, { status: 404 });
    } catch (error) {
      return mobileJson(
        { error: error instanceof Error ? error.message : 'MCP connection could not be deleted.' },
        { status: 409 },
      );
    }
  }
  const deleted = await getApplication().deleteMcpConnection(id);
  return deleted
    ? mobileJson({ ok: true })
    : mobileJson({ error: 'MCP connection not found.' }, { status: 404 });
}

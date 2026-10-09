import { readBoundedJson } from '@assistant/application/http-body';
import {
  changeOwnerPack,
  listPackSources,
  listSituationPacks,
} from '@assistant/application/situations';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import {
  FirestoreSituationPackMutationRepository,
  FirestoreSituationPackReadRepository,
} from '@assistant/firestore';
import { getAgentIdentity, getDb, getFirestoreInstallationStore } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
    const repository = new FirestoreSituationPackReadRepository(getFirestoreInstallationStore());
    return mobileJson(await repository.overview(config.FIRESTORE_AGENT_ID));
  }
  const agent = await getAgentIdentity();
  if (!agent.id) return mobileJson({ packs: [], sources: [] });
  const [packs, sources] = await Promise.all([
    listSituationPacks(getDb(), agent.id),
    listPackSources(getDb(), agent.id),
  ]);
  return mobileJson({ packs, sources });
}

export async function POST(request: Request) {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
  }
  const agent = await getAgentIdentity();
  if (
    !agent.id ||
    (config.PERSISTENCE_DRIVER === 'firestore' && agent.id !== config.FIRESTORE_AGENT_ID)
  )
    return mobileJson({ ok: false, error: 'Owner unavailable.' }, { status: 404 });

  const parsed = await readBoundedJson(request, 32_000, 10_000);
  if (!parsed.ok) {
    return mobileJson(
      {
        ok: false,
        error: parsed.status === 413 ? 'Pack command is too large.' : parsed.error,
      },
      { status: parsed.status },
    );
  }
  const input = parsed.value;
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const repository = new FirestoreSituationPackMutationRepository(
      getFirestoreInstallationStore(),
      agent.id,
    );
    const result = await repository.command(input, { ownerConfirmed: true });
    return mobileJson(result, { status: result.ok ? 200 : 409 });
  }
  const result = await changeOwnerPack(getDb(), agent.id, input);
  return mobileJson(result, { status: result.ok ? 200 : 409 });
}

import {
  getVoiceOverview,
  purgeProfileVoiceSamples,
  recompileProfileCard,
  updateVoiceProfile,
} from '@assistant/application/profile';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import {
  assertPrivacyErasureFenceUnchanged,
  createInstallationStore,
  FirestoreOwnerCardCompilationRepository,
  FirestoreProfileVoiceOverviewRepository,
  FirestoreVoiceProfileRepository,
  FirestoreVoiceSamplePurgeRepository,
  readPrivacyErasureFence,
} from '@assistant/firestore';
import { forgetOwnerLongTermMemory } from '@/lib/memory-erasure';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import {
  getDb,
  getFirestoreInstallationStore,
  getWorkspace,
  organizeOwnerMemoryNow,
} from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const ACTIONS = 'organize, recompile, purge-voice, voice-profile, or forget-all';

/** The distilled writing voice, so the phone can edit the same profile the web does. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const store = createInstallationStore({
      projectId: config.GCP_PROJECT,
      installationId: config.ASSISTANT_WORKSPACE_ID,
      databaseId: config.FIRESTORE_DATABASE_ID,
    });
    try {
      const assertConfiguredOwner = async () => {
        const agents = await store.collection('agents').limit(2).get();
        if (
          agents.size !== 1 ||
          agents.docs[0]?.id !== store.doc('agents', config.FIRESTORE_AGENT_ID).id ||
          agents.docs[0]?.get('id') !== config.FIRESTORE_AGENT_ID
        )
          throw new Error('Voice overview requires one matching configured owner');
      };
      await assertConfiguredOwner();
      const fence = await readPrivacyErasureFence(store, config.FIRESTORE_AGENT_ID);
      const { voiceStats, voiceProfile } = await getVoiceOverview(
        new FirestoreProfileVoiceOverviewRepository(store, config.FIRESTORE_AGENT_ID),
      );
      await assertConfiguredOwner();
      await assertPrivacyErasureFenceUnchanged(store, config.FIRESTORE_AGENT_ID, fence);
      return mobileJson({ voiceStats, voiceProfile });
    } finally {
      await store.db.terminate();
    }
  }
  const { voiceStats, voiceProfile } = await getVoiceOverview(getDb());
  return mobileJson({ voiceStats, voiceProfile });
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const mutationBody = await readMobileMutationBody(request, [
    'action',
    'confirm',
    'description',
    'donts',
    'dos',
    'signature',
  ]);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value as {
    action?: unknown;
    confirm?: unknown;
    description?: unknown;
    dos?: unknown;
    donts?: unknown;
    signature?: unknown;
  } | null;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  /**
   * GET hands back `dos`/`donts` as arrays, so a client that reads the profile,
   * edits it and posts it back sends arrays too. The application layer wants
   * the newline-separated form the web textarea produces, and coercing with
   * `text()` alone turned every array into '' — silently erasing both lists
   * while description and signature saved fine. Accept either shape.
   */
  const lines = (value: unknown) =>
    Array.isArray(value) ? value.map(text).join('\n') : text(value);
  const config = loadConfig();
  const firestore = config.PERSISTENCE_DRIVER === 'firestore';
  try {
    switch (body?.action) {
      case 'organize':
        return mobileJson({ ok: true, ...(await organizeOwnerMemoryNow()) });
      case 'recompile':
        if (firestore) {
          const problems = validateAgentPersistenceConfig(config);
          if (problems.length) throw new Error(problems.join('; '));
          const store = createInstallationStore({
            projectId: config.GCP_PROJECT,
            installationId: config.ASSISTANT_WORKSPACE_ID,
            databaseId: config.FIRESTORE_DATABASE_ID,
          });
          try {
            const assertConfiguredOwner = async () => {
              const owners = await store.collection('agents').limit(2).get();
              if (
                owners.size !== 1 ||
                owners.docs[0]?.id !== store.doc('agents', config.FIRESTORE_AGENT_ID).id ||
                owners.docs[0]?.get('id') !== config.FIRESTORE_AGENT_ID
              )
                throw new Error('Profile recompilation requires one matching configured owner');
            };
            await assertConfiguredOwner();
            const fence = await readPrivacyErasureFence(store, config.FIRESTORE_AGENT_ID);
            await recompileProfileCard(
              new FirestoreOwnerCardCompilationRepository(store),
              config.FIRESTORE_AGENT_ID,
            );
            await assertConfiguredOwner();
            await assertPrivacyErasureFenceUnchanged(store, config.FIRESTORE_AGENT_ID, fence);
          } finally {
            await store.db.terminate();
          }
        } else await recompileProfileCard(getDb());
        return mobileJson({ ok: true });
      case 'purge-voice':
        return mobileJson({
          ok: true,
          ...(await purgeProfileVoiceSamples(
            firestore
              ? new FirestoreVoiceSamplePurgeRepository(
                  getFirestoreInstallationStore(),
                  config.FIRESTORE_AGENT_ID,
                )
              : getDb(),
            getWorkspace(),
          )),
        });
      case 'voice-profile': {
        const input = {
          description: text(body.description),
          dos: lines(body.dos),
          donts: lines(body.donts),
          signature: text(body.signature),
        };
        let result: { error?: string };
        if (firestore) {
          const problems = validateAgentPersistenceConfig(config);
          if (problems.length) throw new Error(problems.join('; '));
          const store = createInstallationStore({
            projectId: config.GCP_PROJECT,
            installationId: config.ASSISTANT_WORKSPACE_ID,
            databaseId: config.FIRESTORE_DATABASE_ID,
          });
          try {
            result = await new FirestoreVoiceProfileRepository(store).update(
              config.FIRESTORE_AGENT_ID,
              input,
            );
          } finally {
            await store.db.terminate();
          }
        } else result = await updateVoiceProfile(getDb(), input);
        if (result.error) return mobileJson({ error: result.error }, { status: 400 });
        return mobileJson({ ok: true });
      }
      // Irreversible, and the one action here the owner can never undo, so it
      // stays explicit rather than riding along with purge-voice. It also wants
      // the intent spelled out a second time: every other action on this route
      // is recoverable, so a malformed or mis-sent body should not be one field
      // away from erasing everything.
      case 'forget-all':
        if (body.confirm !== 'forget-all') {
          return mobileJson(
            { error: 'forget-all requires confirm: "forget-all"' },
            { status: 400 },
          );
        }
        await forgetOwnerLongTermMemory();
        return mobileJson({ ok: true });
      default:
        return mobileJson({ error: `action must be ${ACTIONS}` }, { status: 400 });
    }
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Memory profile could not be updated.' },
      { status: 409 },
    );
  }
}

import { createSettingsFacade } from '@assistant/application/settings';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import {
  assertPrivacyErasureFenceUnchanged,
  createFirestoreSettingsPersistence,
  readPrivacyErasureFence,
} from '@assistant/firestore';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { getApplication, getFirestoreInstallationStore } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** Update editable identity settings through the same validated command as the web form. */
export async function PATCH(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const mutationBody = await readMobileMutationBody(request, ['timezone', 'locale', 'signature']);
  if (!mutationBody.ok) return mutationBody.response;
  const body = mutationBody.value as Record<string, unknown> | null;
  if (!body || Array.isArray(body)) {
    return mobileJson({ error: 'invalid settings body' }, { status: 400 });
  }
  const input = {
    timezone: typeof body.timezone === 'string' ? body.timezone : '',
    locale: typeof body.locale === 'string' ? body.locale : '',
    signature: typeof body.signature === 'string' ? body.signature : '',
  };
  const config = loadConfig();
  let result: { error?: string };
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    const store = getFirestoreInstallationStore();
    const assertConfiguredOwner = async () => {
      const agents = await store.collection('agents').limit(2).get();
      if (
        agents.size !== 1 ||
        agents.docs[0]?.id !== store.doc('agents', config.FIRESTORE_AGENT_ID).id ||
        agents.docs[0]?.get('id') !== config.FIRESTORE_AGENT_ID
      )
        throw new Error('Settings update requires exactly one configured agent');
    };
    await assertConfiguredOwner();
    const fence = await readPrivacyErasureFence(store, config.FIRESTORE_AGENT_ID);
    result = await createSettingsFacade(
      createFirestoreSettingsPersistence(store, config.FIRESTORE_AGENT_ID),
    ).updateAssistantSettings(input);
    await assertConfiguredOwner();
    await assertPrivacyErasureFenceUnchanged(store, config.FIRESTORE_AGENT_ID, fence);
  } else {
    result = await getApplication().updateSettings(input);
  }
  return result.error
    ? mobileJson({ error: result.error }, { status: 400 })
    : mobileJson({ ok: true });
}

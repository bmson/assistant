'use server';

import { decideOwnerEmailObligation } from '@assistant/application/email-obligations';
import {
  addPersonOccasion,
  createPerson,
  deletePerson,
  forgetPersonOccasion,
  mergePeople,
  type OrganizeMemoryState,
  type PersonOccasionInput,
  type ProminenceLevel,
  purgeProfileVoiceSamples,
  recompileProfileCard,
  reviewPersonOccasion,
  updatePersonIdentity,
  updatePersonOccasion,
  updatePersonRelationship,
  updateVoiceProfile,
} from '@assistant/application/profile';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import {
  FirestoreOwnerCardCompilationRepository,
  FirestoreVoiceProfileRepository,
  FirestoreVoiceSamplePurgeRepository,
  readPrivacyErasureFence,
} from '@assistant/firestore';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import {
  deleteFirestorePerson,
  getFirestoreProfileCommands,
  mergeFirestorePeople,
  recompileFirestoreProfileCard,
} from '@/lib/firestore-profile-commands';
import { forgetOwnerLongTermMemory } from '@/lib/memory-erasure';
import {
  getDb,
  getEmailObligationRepository,
  getFirestoreInstallationStore,
  getOwnerMemoryCommands,
  getWorkspace,
  organizeOwnerMemoryNow,
} from '@/lib/server';

export type { OrganizeMemoryState, ProminenceLevel } from '@assistant/application/profile';

function revalidateProfile(): void {
  revalidatePath('/profile', 'layout');
  // Memory edits also affect graph eligibility. Keep the workspace in sync
  // instead of making the owner navigate away and back after a correction.
  revalidatePath('/profile/knowledge');
  // The People section reads the same contacts, occasions, and facts, so a
  // rename or a new occasion has to land there too — these actions are shared
  // by both surfaces.
  revalidatePath('/people', 'layout');
}

export async function resolveCommitmentAction(id: string): Promise<void> {
  await requireOwner();
  await getOwnerMemoryCommands().resolveCommitment(id, 'Owner confirmed this loop is resolved.');
  revalidateProfile();
}

export async function decideEmailObligationAction(
  channelMessageId: string,
  expectedVersion: number,
  decision: 'confirm_open' | 'resolve' | 'snooze' | 'reopen',
): Promise<void> {
  await requireOwner();
  const now = new Date();
  const changed = await decideOwnerEmailObligation(getEmailObligationRepository(), {
    channelMessageId,
    expectedVersion,
    decision,
    now,
    ...(decision === 'snooze' ? { snoozedUntil: new Date(now.getTime() + 24 * 3600_000) } : {}),
  });
  if (!changed)
    throw new Error(
      'This email source changed or was already updated. Refresh and review the latest message.',
    );
  revalidateProfile();
}

export async function dismissCommitmentAction(id: string): Promise<void> {
  await requireOwner();
  await getOwnerMemoryCommands().dismissCommitment(id);
  revalidateProfile();
}

export async function snoozeCommitmentAction(id: string): Promise<void> {
  await requireOwner();
  await getOwnerMemoryCommands().snoozeCommitment(id, new Date(Date.now() + 24 * 3600 * 1000));
  revalidateProfile();
}

export async function correctCommitmentAction(
  id: string,
  title: string,
  details: string,
  nextAction: string,
): Promise<void> {
  await requireOwner();
  await getOwnerMemoryCommands().correctCommitment(id, { title, details, nextAction });
  revalidateProfile();
}

export async function correctCommitmentFormAction(id: string, formData: FormData): Promise<void> {
  await correctCommitmentAction(
    id,
    String(formData.get('title') ?? ''),
    String(formData.get('details') ?? ''),
    String(formData.get('nextAction') ?? ''),
  );
}

export async function reopenCommitmentAction(
  id: string,
  expectedUpdatedAt: string,
  operationId: string,
): Promise<void> {
  await requireOwner();
  const timestamp = new Date(expectedUpdatedAt);
  if (!Number.isFinite(timestamp.getTime()))
    throw new Error('Refresh this closed loop to reopen it.');
  const result = await getOwnerMemoryCommands().reopenCommitment(id, timestamp, operationId);
  if (!result)
    throw new Error(
      'This closed loop changed or newer evidence is already open. Refresh and review it.',
    );
  revalidateProfile();
}

export async function confirmFact(memoryId: string): Promise<void> {
  await requireOwner();
  await getOwnerMemoryCommands().confirmMemory(memoryId);
  revalidateProfile();
}

export async function correctFact(memoryId: string, content: string): Promise<{ error?: string }> {
  await requireOwner();
  const result = await getOwnerMemoryCommands().correctMemory(memoryId, content);
  revalidateProfile();
  return result;
}

export async function forgetFact(memoryId: string): Promise<void> {
  await requireOwner();
  await getOwnerMemoryCommands().forgetMemory(memoryId);
  revalidateProfile();
}

export async function setFactProminence(memoryId: string, level: ProminenceLevel): Promise<void> {
  await requireOwner();
  await getOwnerMemoryCommands().setMemoryProminence(memoryId, level);
  revalidateProfile();
}

export async function approveQuarantined(memoryId: string): Promise<void> {
  await requireOwner();
  await getOwnerMemoryCommands().approveQuarantinedMemory(memoryId);
  revalidateProfile();
}

export async function rejectQuarantined(memoryId: string): Promise<void> {
  await requireOwner();
  await getOwnerMemoryCommands().rejectQuarantinedMemory(memoryId);
  revalidateProfile();
}

export async function updateContactRelationship(
  contactId: string,
  relationship: string,
): Promise<void> {
  await requireOwner();
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const commands = getFirestoreProfileCommands();
    await updatePersonRelationship(commands.people, contactId, relationship);
    await recompileFirestoreProfileCard(commands);
  } else {
    await updatePersonRelationship(getDb(), contactId, relationship);
  }
  revalidateProfile();
}

export async function updateContactIdentityAction(
  contactId: string,
  name: string,
  aliasesText: string,
): Promise<{ error?: string }> {
  await requireOwner();
  const config = loadConfig();
  const commands = config.PERSISTENCE_DRIVER === 'firestore' ? getFirestoreProfileCommands() : null;
  const result = await updatePersonIdentity(
    commands?.people ?? getDb(),
    contactId,
    name,
    aliasesText,
  );
  if (commands && !result.error) await recompileFirestoreProfileCard(commands);
  revalidateProfile();
  return result;
}

export async function deleteContactAction(contactId: string): Promise<{ error?: string }> {
  await requireOwner();
  const result =
    loadConfig().PERSISTENCE_DRIVER === 'firestore'
      ? await deleteFirestorePerson(contactId)
      : await deletePerson(getDb(), contactId);
  revalidateProfile();
  return result;
}

export async function recompileCard(): Promise<void> {
  await requireOwner();
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    const store = getFirestoreInstallationStore();
    const agents = await store.collection('agents').limit(2).get();
    const owner = agents.docs[0];
    if (
      agents.size !== 1 ||
      !owner ||
      owner.id !== store.doc('agents', config.FIRESTORE_AGENT_ID).id ||
      owner.get('id') !== config.FIRESTORE_AGENT_ID
    )
      throw new Error('Owner card refresh requires exactly one configured agent');
    await readPrivacyErasureFence(store, config.FIRESTORE_AGENT_ID);
    await recompileProfileCard(
      new FirestoreOwnerCardCompilationRepository(store),
      config.FIRESTORE_AGENT_ID,
    );
  } else {
    await recompileProfileCard(getDb());
  }
  revalidateProfile();
}

export async function consolidateNow(
  _previous: OrganizeMemoryState,
  _formData: FormData,
): Promise<OrganizeMemoryState> {
  await requireOwner();
  const result = await organizeOwnerMemoryNow();
  revalidateProfile();
  return result;
}

export async function mergeContactAction(
  sourceId: string,
  targetId: string,
): Promise<{ error?: string }> {
  await requireOwner();
  const result =
    loadConfig().PERSISTENCE_DRIVER === 'firestore'
      ? await mergeFirestorePeople(sourceId, targetId)
      : await mergePeople(getDb(), sourceId, targetId);
  revalidateProfile();
  return result;
}

export async function purgeVoiceSamplesAction(): Promise<void> {
  await requireOwner();
  const config = loadConfig();
  await purgeProfileVoiceSamples(
    config.PERSISTENCE_DRIVER === 'firestore'
      ? new FirestoreVoiceSamplePurgeRepository(
          getFirestoreInstallationStore(),
          config.FIRESTORE_AGENT_ID,
        )
      : getDb(),
    getWorkspace(),
  );
  revalidateProfile();
}

/** Irreversible owner control for the data that drives recall and voice imitation. */
export async function forgetLongTermMemoryAction(): Promise<void> {
  await requireOwner();
  await forgetOwnerLongTermMemory();
  revalidateProfile();
  revalidatePath('/chat', 'layout');
}

/** Edit the distilled voice profile (description, do's, don'ts, signature). */
export async function updateVoiceProfileAction(input: {
  description: string;
  dos: string;
  donts: string;
  signature: string;
}): Promise<{ error?: string }> {
  await requireOwner();
  const config = loadConfig();
  const result =
    config.PERSISTENCE_DRIVER === 'firestore'
      ? await new FirestoreVoiceProfileRepository(getFirestoreInstallationStore()).update(
          config.FIRESTORE_AGENT_ID,
          input,
        )
      : await updateVoiceProfile(getDb(), input);
  if (result.error) return result;
  revalidateProfile();
  revalidatePath('/profile/voice');
  return {};
}

export async function createPersonAction(input: {
  name: string;
  relationship: string;
  aliases: string;
}): Promise<{ error?: string; contactId?: string }> {
  await requireOwner();
  const config = loadConfig();
  const commands = config.PERSISTENCE_DRIVER === 'firestore' ? getFirestoreProfileCommands() : null;
  const result = await createPerson(commands?.people ?? getDb(), input);
  if (commands && result.contactId) await recompileFirestoreProfileCard(commands);
  revalidateProfile();
  return result;
}

export async function createMemoryAction(input: {
  content: string;
  domain: string;
  importance: string;
  pinned: boolean;
  subjectContactId: string;
}): Promise<{ error?: string }> {
  await requireOwner();
  const result = await getOwnerMemoryCommands().createMemory(input);
  revalidateProfile();
  return result;
}

export async function addOccasionAction(
  contactId: string,
  input: {
    kind: string;
    label: string;
    month: string;
    day: string;
    year: string;
    leadDays: string;
    notes: string;
  },
): Promise<{ error?: string }> {
  await requireOwner();
  const config = loadConfig();
  const repository =
    config.PERSISTENCE_DRIVER === 'firestore' ? getFirestoreProfileCommands().occasions : getDb();
  const result = await addPersonOccasion(repository, contactId, input);
  revalidateProfile();
  return result;
}

export async function forgetOccasionAction(occasionId: string): Promise<void> {
  await requireOwner();
  const config = loadConfig();
  const repository =
    config.PERSISTENCE_DRIVER === 'firestore' ? getFirestoreProfileCommands().occasions : getDb();
  await forgetPersonOccasion(repository, occasionId);
  revalidateProfile();
}

export async function reviewOccasionAction(
  occasionId: string,
  verdict: 'approve' | 'reject',
): Promise<void> {
  await requireOwner();
  const config = loadConfig();
  const repository =
    config.PERSISTENCE_DRIVER === 'firestore' ? getFirestoreProfileCommands().occasions : getDb();
  await reviewPersonOccasion(repository, occasionId, verdict);
  revalidateProfile();
}

export async function updateOccasionAction(
  occasionId: string,
  input: PersonOccasionInput,
): Promise<{ error?: string }> {
  await requireOwner();
  const config = loadConfig();
  const repository =
    config.PERSISTENCE_DRIVER === 'firestore' ? getFirestoreProfileCommands().occasions : getDb();
  const result = await updatePersonOccasion(repository, occasionId, input);
  revalidateProfile();
  return result;
}

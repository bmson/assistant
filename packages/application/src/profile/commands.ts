import { getAgent } from '@assistant/core/chat';
import { InboundEventSchema } from '@assistant/core/events';
import { compileOwnerCard } from '@assistant/core/memory/consolidation';
import { isOccasionKind, saveOccasion } from '@assistant/core/memory/occasions';
import { purgeVoiceSamples } from '@assistant/core/memory/voice-ingest';
import { enqueueTask } from '@assistant/core/workflow/machine';
import {
  contacts,
  createPostgresActiveJobLookup,
  createPostgresOwnerCardCompilationRepository,
  createPostgresProfileMemoryMaintenance,
  createPostgresProfileMemoryManagementRepository,
  type Db,
  deleteContact,
  mergeContacts,
  normalizeContactAliases,
  normalizeContactName,
  occasions,
  updateContactIdentity,
  voiceProfile,
} from '@assistant/db';
import {
  type ActiveJobLookup,
  isOwnerCardCompilationRepository,
  isProfileOccasionCommandRepository,
  isProfilePeopleCommandRepository,
  normalizeVoiceProfileEdit,
  type OwnerCardCompilationRepository,
  type ProfileOccasionCommandInput,
  type ProfileOccasionCommandRepository,
  type ProfilePeopleCommandRepository,
  type ProfilePeopleRemovalRepository,
  type TaskRepository,
  type VoiceSamplePurgeRepository,
} from '@assistant/persistence';
import { and, eq, sql } from 'drizzle-orm';
import {
  type CreateProfileMemoryInput,
  createProfileMemoryCommands,
  type ProfileMemoryCommandPersistence,
  type ProfileMemoryEmbeddingPort,
} from './memory-commands.js';

export function createPostgresProfileMemoryCommandPersistence(
  db: Db,
  agentId?: string,
): ProfileMemoryCommandPersistence {
  return {
    kind: 'profile-memory-command-persistence',
    memories: createPostgresProfileMemoryManagementRepository(db, agentId),
    ownerCards: createPostgresOwnerCardCompilationRepository(db),
    maintenance: createPostgresProfileMemoryMaintenance(db, async (input) => {
      await enqueueTask(db, {
        event: InboundEventSchema.parse(input.trigger),
        type: input.type,
      });
    }),
  };
}

export function profileMemoryCommands(
  store: Db | ProfileMemoryCommandPersistence,
  router: ProfileMemoryEmbeddingPort = {
    async embed() {
      throw new Error('Memory authoring requires an embedding provider');
    },
  },
) {
  const persistence =
    'kind' in store && store.kind === 'profile-memory-command-persistence'
      ? (store as ProfileMemoryCommandPersistence)
      : createPostgresProfileMemoryCommandPersistence(store as Db);
  const commands = createProfileMemoryCommands(persistence, router);
  if ('kind' in store && store.kind === 'profile-memory-command-persistence') return commands;
  // Legacy callers silently ignore missing/foreign facts. Keep that behavior
  // while transactional adapters enforce the single-owner invariant themselves.
  const existing = async (id: string, run: () => Promise<void>): Promise<void> => {
    if (await persistence.memories.get(id)) await run();
  };
  return {
    ...commands,
    confirmMemory: (id: string) => existing(id, () => commands.confirmMemory(id)),
    restoreMemory: (id: string) => existing(id, () => commands.restoreMemory(id)),
    forgetMemory: (id: string) => existing(id, () => commands.forgetMemory(id)),
    setMemoryProminence: (id: string, level: ProminenceLevel) =>
      existing(id, () => commands.setMemoryProminence(id, level)),
    approveQuarantinedMemory: (id: string) =>
      existing(id, () => commands.approveQuarantinedMemory(id)),
    rejectQuarantinedMemory: (id: string) =>
      existing(id, () => commands.rejectQuarantinedMemory(id)),
  };
}

export interface EmbeddingPort {
  embed(texts: string[]): Promise<number[][]>;
  embeddingSpace(): Promise<import('@assistant/persistence').EmbeddingSpace>;
}

export interface WorkspaceDeletePort {
  delete(relativePath: string): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ProminenceLevel = 'always' | 'auto' | 'minor';

export function confirmMemory(
  store: Db | ProfileMemoryCommandPersistence,
  memoryId: string,
): Promise<void> {
  return profileMemoryCommands(store).confirmMemory(memoryId);
}

export function restoreMemory(
  store: Db | ProfileMemoryCommandPersistence,
  memoryId: string,
): Promise<void> {
  return profileMemoryCommands(store).restoreMemory(memoryId);
}

export function correctMemory(
  store: Db | ProfileMemoryCommandPersistence,
  router: EmbeddingPort,
  memoryId: string,
  content: string,
): Promise<{ error?: string }> {
  return profileMemoryCommands(store, router).correctMemory(memoryId, content);
}

export function forgetMemory(
  store: Db | ProfileMemoryCommandPersistence,
  memoryId: string,
): Promise<void> {
  return profileMemoryCommands(store).forgetMemory(memoryId);
}

export function setMemoryProminence(
  store: Db | ProfileMemoryCommandPersistence,
  memoryId: string,
  level: ProminenceLevel,
): Promise<void> {
  return profileMemoryCommands(store).setMemoryProminence(memoryId, level);
}

export function approveQuarantinedMemory(
  store: Db | ProfileMemoryCommandPersistence,
  memoryId: string,
): Promise<void> {
  return profileMemoryCommands(store).approveQuarantinedMemory(memoryId);
}

export function rejectQuarantinedMemory(
  store: Db | ProfileMemoryCommandPersistence,
  memoryId: string,
): Promise<void> {
  return profileMemoryCommands(store).rejectQuarantinedMemory(memoryId);
}

export async function updatePersonRelationship(
  store: Db | ProfilePeopleCommandRepository,
  contactId: string,
  relationship: string,
): Promise<void> {
  const trimmed = relationship.trim().slice(0, 80);
  if (isProfilePeopleCommandRepository(store)) {
    await store.updateRelationship(contactId, trimmed);
    return;
  }
  const db = store;
  await db
    .update(contacts)
    .set({
      relationship: trimmed,
      ...(trimmed
        ? {
            trust: sql`CASE WHEN ${contacts.trust} = 'unknown' THEN 'known' ELSE ${contacts.trust} END`,
          }
        : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(contacts.id, contactId));
  await compileOwnerCard(db);
}

/**
 * Messages the db layer writes deliberately for the owner to read. Anything
 * else that escapes it — a postgres.js driver error carrying the failed SQL and
 * its bound parameters, a constraint violation, an unforeseen bug — is replaced
 * with a plain fallback and logged instead of rendered. This is an allowlist of
 * intentional copy rather than a blocklist of driver noise, so a new failure
 * mode nobody anticipated degrades quietly instead of leaking by default.
 */
const OWNER_FACING_DB_ERRORS: ReadonlySet<string> = new Set([
  'A person with that name already exists.',
  'Person name is required.',
  'Person name must be 120 characters or fewer.',
  'Person name contains unsupported control characters.',
  'A person can have at most 20 aliases.',
  'Person not found or cannot be renamed.',
  'Person not found.',
  'The owner profile cannot be deleted.',
  'Person could not be deleted.',
  'Person has too many occasions to update safely.',
  'Person has too many knowledge links to update safely.',
]);

export function ownerFacingError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  if (OWNER_FACING_DB_ERRORS.has(message)) return message;
  console.error('[profile] unexpected person command failure:', error);
  return fallback;
}

export async function updatePersonIdentity(
  store: Db | ProfilePeopleCommandRepository,
  contactId: string,
  name: string,
  aliasesText: string,
): Promise<{ error?: string }> {
  if (!UUID_RE.test(contactId)) return { error: 'Invalid person identifier.' };
  try {
    const normalizedName = normalizeContactName(name);
    const aliases = aliasesText
      .slice(0, 4_000)
      .split(/[,\n]/)
      .map((alias) => alias.trim())
      .filter(Boolean);
    const normalizedAliases = normalizeContactAliases(aliases, normalizedName);
    if (isProfilePeopleCommandRepository(store)) {
      await store.updateIdentity(contactId, normalizedName, normalizedAliases);
    } else {
      await updateContactIdentity(store, {
        contactId,
        name: normalizedName,
        aliases: normalizedAliases,
      });
    }
  } catch (error) {
    return { error: ownerFacingError(error, 'Person could not be renamed. Please try again.') };
  }
  if (!isProfilePeopleCommandRepository(store)) await compileOwnerCard(store);
  return {};
}

export async function deletePerson(db: Db, contactId: string): Promise<{ error?: string }> {
  if (!UUID_RE.test(contactId)) return { error: 'Invalid person identifier.' };
  try {
    await deleteContact(db, contactId);
  } catch (error) {
    return { error: ownerFacingError(error, 'Person could not be deleted. Please try again.') };
  }
  await compileOwnerCard(db);
  return {};
}

/** Facts are removed in bounded passes; this many passes is far past any real person. */
const PERSON_FACT_BATCH = 100;
const PERSON_FACT_MAX_PASSES = 200;

/**
 * Delete a non-owner person through portable repositories: every fact about
 * them is forgotten with a tombstone (so extraction cannot recreate it) and
 * its graph projection removed, then their occasions, graph links, and the
 * person go in one final transaction. Safe to retry after an interruption.
 */
export async function deletePersonWithRepository(
  removal: ProfilePeopleRemovalRepository,
  memory: ProfileMemoryCommandPersistence,
  agentId: string,
  contactId: string,
): Promise<{ error?: string }> {
  if (!UUID_RE.test(contactId)) return { error: 'Invalid person identifier.' };
  try {
    await removal.assertRemovable(contactId);
    for (let pass = 0; ; pass += 1) {
      if (pass >= PERSON_FACT_MAX_PASSES) throw new Error('Person facts did not drain');
      const ids = await removal.subjectMemoryIds(contactId, PERSON_FACT_BATCH);
      if (ids.length === 0) break;
      for (const memoryId of ids) {
        const result = await memory.memories.forget(memoryId, 'owner_delete_contact');
        if (result.status === 'updated')
          await memory.maintenance.removeOrphanedGraphEntities({ agentId, memoryId });
      }
    }
    await removal.finishDelete(contactId);
  } catch (error) {
    return { error: ownerFacingError(error, 'Person could not be deleted. Please try again.') };
  }
  await compileOwnerCard(memory.ownerCards, agentId);
  return {};
}

/**
 * Merge one person into another through portable repositories: facts are
 * re-attributed in bounded passes, then occasions, identity fields, and the
 * source's removal commit together. Safe to retry after an interruption.
 */
export async function mergePeopleWithRepository(
  removal: ProfilePeopleRemovalRepository,
  ownerCards: OwnerCardCompilationRepository,
  agentId: string,
  sourceId: string,
  targetId: string,
): Promise<{ error?: string }> {
  try {
    if (sourceId === targetId) throw new Error('cannot merge a contact into itself');
    for (let pass = 0; ; pass += 1) {
      if (pass >= PERSON_FACT_MAX_PASSES) throw new Error('Person facts did not drain');
      const moved = await removal.reassignSubjectMemories(sourceId, targetId, PERSON_FACT_BATCH);
      if (moved === 0) break;
    }
    await removal.finishMerge(sourceId, targetId);
  } catch (error) {
    return {
      error: ownerFacingError(error, 'These people could not be merged. Please try again.'),
    };
  }
  await compileOwnerCard(ownerCards, agentId);
  return {};
}

export function recompileProfileCard(db: Db): Promise<string>;
export function recompileProfileCard(
  repository: OwnerCardCompilationRepository,
  agentId: string,
): Promise<string>;
export function recompileProfileCard(
  store: Db | OwnerCardCompilationRepository,
  agentId?: string,
): Promise<string> {
  if (isOwnerCardCompilationRepository(store)) {
    if (!agentId) throw new Error('Owner card recompilation requires a configured owner');
    return compileOwnerCard(store, agentId);
  }
  return compileOwnerCard(store as Db);
}

export interface OrganizeMemoryState {
  taskId: string | null;
  outcome: 'idle' | 'queued' | 'already-running' | 'error';
  message: string | null;
}

export async function organizeMemoryNow(db: Db): Promise<OrganizeMemoryState> {
  const agent = await getAgent(db);
  return organizeMemoryNowWithRepository(createPostgresActiveJobLookup(db), db, agent.id);
}

/**
 * Queue one owner-requested consolidation pass, or report the one already
 * queued or running. The task goes through the configured task repository.
 */
export async function organizeMemoryNowWithRepository(
  jobs: ActiveJobLookup,
  taskStore: Db | TaskRepository,
  agentId: string,
): Promise<OrganizeMemoryState> {
  const active = await jobs.findActive(agentId, 'memory.consolidate');
  if (active) {
    return {
      taskId: active.id,
      outcome: 'already-running',
      message:
        active.status === 'running'
          ? 'Memory organization is already in progress.'
          : 'Memory organization is already queued.',
    };
  }
  const event = InboundEventSchema.parse({
    source: 'internal',
    externalEventId: `profile:consolidate:${new Date().toISOString().slice(0, 16)}`,
    agentId,
    trust: 'assistant',
    payload: { job: 'memory.consolidate', instruction: 'owner-requested memory consolidation' },
  });
  const { task } = await enqueueTask(taskStore, {
    event,
    type: 'scheduled',
    budgetUsdLimit: '0.10',
  });
  return {
    taskId: task.id,
    outcome: 'queued',
    message: 'Memory organization is queued. This page will update as it works.',
  };
}

export async function mergePeople(
  db: Db,
  sourceId: string,
  targetId: string,
): Promise<{ error?: string }> {
  try {
    await mergeContacts(db, { sourceId, targetId });
  } catch (error) {
    return {
      error: ownerFacingError(error, 'These people could not be merged. Please try again.'),
    };
  }
  await compileOwnerCard(db);
  return {};
}

export function purgeProfileVoiceSamples(
  storage: Db | VoiceSamplePurgeRepository,
  workspace: WorkspaceDeletePort,
): Promise<{ deleted: number }> {
  return purgeVoiceSamples(storage, workspace);
}

/**
 * Edit the distilled voice profile the rewriter imitates. The lists arrive as
 * one entry per line from the form; blank lines drop. Bounds match the
 * ingest-time profile, so an owner edit can never smuggle a prompt's worth of
 * prose into the rewrite step.
 */
export async function updateVoiceProfile(
  db: Db,
  input: { description: string; dos: string; donts: string; signature: string },
): Promise<{ error?: string }> {
  const normalized = normalizeVoiceProfileEdit(input);
  if (!normalized.value) return { error: normalized.error };
  const { description, dos, donts, signature } = normalized.value;
  await db
    .insert(voiceProfile)
    .values({
      id: 1,
      description,
      dos,
      donts,
      signature,
      updatedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: voiceProfile.id,
      set: {
        description,
        dos,
        donts,
        signature,
        updatedAt: sql`now()`,
      },
    });
  return {};
}

export async function createPerson(
  store: Db | ProfilePeopleCommandRepository,
  input: { name: string; relationship: string; aliases: string },
): Promise<{ error?: string; contactId?: string }> {
  const name = input.name.trim().slice(0, 120);
  if (name.length < 1) return { error: 'Enter a name.' };
  if (isProfilePeopleCommandRepository(store)) {
    try {
      const aliases = normalizeContactAliases(
        input.aliases
          .slice(0, 4_000)
          .split(/[,\n]/)
          .map((alias) => alias.trim())
          .filter(Boolean),
        name,
      );
      const contactId = await store.create({
        name,
        relationship: input.relationship.trim().slice(0, 80),
        aliases,
      });
      return { contactId };
    } catch (error) {
      return {
        error: ownerFacingError(error, 'Person could not be added. Please try again.'),
      };
    }
  }
  const db = store;
  const [existing] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(sql`lower(${contacts.name}) = ${name.toLowerCase()}`)
    .limit(1);
  if (existing) return { error: 'A person with that name already exists.' };
  const aliases = normalizeContactAliases(
    input.aliases
      .slice(0, 4_000)
      .split(/[,\n]/)
      .map((alias) => alias.trim())
      .filter(Boolean),
    name,
  );
  const [row] = await db
    .insert(contacts)
    .values({ name, relationship: input.relationship.trim().slice(0, 80), trust: 'known', aliases })
    .returning({ id: contacts.id });
  await compileOwnerCard(db);
  return { contactId: row?.id };
}

export function createMemory(
  store: Db | ProfileMemoryCommandPersistence,
  router: EmbeddingPort,
  input: CreateProfileMemoryInput,
): Promise<{ error?: string }> {
  return profileMemoryCommands(store, router).createMemory(input);
}

export interface PersonOccasionInput {
  kind: string;
  label: string;
  month: string;
  day: string;
  year: string;
  leadDays: string;
  notes: string;
}

/** Edit the exact date in place, including clearing a previously saved year. */
export async function updatePersonOccasion(
  store: Db | ProfileOccasionCommandRepository,
  occasionId: string,
  input: PersonOccasionInput,
): Promise<{ error?: string }> {
  if (!UUID_RE.test(occasionId)) return { error: 'Invalid occasion identifier.' };
  const normalized = normalizePersonOccasionInput(input);
  if ('error' in normalized) return { error: normalized.error };
  if (isProfileOccasionCommandRepository(store)) {
    try {
      const updated = await store.update(occasionId, normalized.value);
      return updated ? {} : { error: 'That occasion no longer exists.' };
    } catch {
      return {
        error:
          'Occasion could not be saved. Check whether this date is already recorded and try again.',
      };
    }
  }
  const db = store;
  const agent = await getAgent(db);
  const [existing] = await db
    .select({ contactId: occasions.contactId })
    .from(occasions)
    .where(and(eq(occasions.id, occasionId), eq(occasions.agentId, agent.id)))
    .limit(1);
  if (!existing) return { error: 'That occasion no longer exists.' };
  return addPersonOccasion(db, existing.contactId, input, occasionId);
}

export async function addPersonOccasion(
  store: Db | ProfileOccasionCommandRepository,
  contactId: string,
  input: PersonOccasionInput,
  occasionId?: string,
): Promise<{ error?: string }> {
  if (!UUID_RE.test(contactId)) return { error: 'Invalid person identifier.' };
  if (occasionId && !UUID_RE.test(occasionId)) return { error: 'Invalid occasion identifier.' };
  const normalizedInput = normalizePersonOccasionInput(input);
  if ('error' in normalizedInput) return { error: normalizedInput.error };
  try {
    if (occasionId) {
      if (isProfileOccasionCommandRepository(store)) {
        const updated = await store.update(occasionId, normalizedInput.value, contactId);
        return updated ? {} : { error: 'That occasion no longer exists.' };
      } else {
        const db = store;
        const agent = await getAgent(db);
        const updated = await db
          .update(occasions)
          .set({
            ...normalizedInput.value,
            originTrust: 'owner',
            ownerConfirmed: true,
            quarantined: false,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(occasions.id, occasionId),
              eq(occasions.agentId, agent.id),
              eq(occasions.contactId, contactId),
            ),
          )
          .returning({ id: occasions.id });
        return updated.length ? {} : { error: 'That occasion no longer exists.' };
      }
    }
    const normalized = { contactId, ...normalizedInput.value };
    if (isProfileOccasionCommandRepository(store)) {
      await store.create(normalized);
    } else {
      const agent = await getAgent(store);
      await saveOccasion(store, {
        ...normalized,
        agentId: agent.id,
        originTrust: 'owner',
        quarantined: false,
        ownerConfirmed: true,
        source: 'profile',
      });
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Person not found.')
      return { error: error.message };
    if (error instanceof Error && error.message === 'Privacy erasure is in progress')
      return { error: error.message };
    return {
      error:
        'Occasion could not be saved. Check whether this date is already recorded and try again.',
    };
  }
  return {};
}

function normalizePersonOccasionInput(
  input: PersonOccasionInput,
): { value: Omit<ProfileOccasionCommandInput, 'contactId'> } | { error: string } {
  if (!isOccasionKind(input.kind)) return { error: 'Choose an occasion type.' };
  const month = Number(input.month);
  const day = Number(input.day);
  const year = input.year.trim() ? Number(input.year) : null;
  if (
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31
  ) {
    return { error: 'Enter a valid month (1–12) and day (1–31).' };
  }
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2200)) {
    return { error: 'Enter a valid year, or leave it blank.' };
  }
  if (day > new Date(Date.UTC(year ?? 2000, month, 0)).getUTCDate()) {
    return { error: 'That date does not exist. Check the month, day, and year.' };
  }
  const leadDays = input.leadDays.trim() ? Number(input.leadDays) : 7;
  if (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > 60) {
    return { error: 'Choose a reminder between 0 and 60 days before.' };
  }
  return {
    value: {
      kind: input.kind,
      label: input.label.trim().slice(0, 120),
      month,
      day,
      year,
      leadDays,
      notes: input.notes.trim().slice(0, 2000),
    },
  };
}

export async function forgetPersonOccasion(
  store: Db | ProfileOccasionCommandRepository,
  occasionId: string,
): Promise<void> {
  if (!UUID_RE.test(occasionId)) return;
  if (isProfileOccasionCommandRepository(store)) return store.forget(occasionId);
  const db = store;
  const agent = await getAgent(db);
  await db
    .delete(occasions)
    .where(and(eq(occasions.id, occasionId), eq(occasions.agentId, agent.id)));
}

export async function reviewPersonOccasion(
  store: Db | ProfileOccasionCommandRepository,
  occasionId: string,
  verdict: 'approve' | 'reject',
): Promise<void> {
  if (!UUID_RE.test(occasionId)) return;
  if (isProfileOccasionCommandRepository(store)) return store.review(occasionId, verdict);
  const db = store;
  const agent = await getAgent(db);
  if (verdict === 'approve') {
    await db
      .update(occasions)
      .set({ quarantined: false, ownerConfirmed: true, updatedAt: sql`now()` })
      .where(and(eq(occasions.id, occasionId), eq(occasions.agentId, agent.id)));
  } else {
    await db
      .delete(occasions)
      .where(and(eq(occasions.id, occasionId), eq(occasions.agentId, agent.id)));
  }
}

import { prepareOwnerKnowledgeGraphFactWithRepository } from '@assistant/core/memory/knowledge-graph';
import type { OwnerMemoryEditorSnapshot } from '@assistant/persistence';
import {
  normalizeContactAliases,
  normalizeContactName,
  type OwnerEditorApply,
  type OwnerEditorClaim,
  type OwnerEditorFamilyFields,
  type OwnerEditorGraphExpectations,
  type OwnerEditorPersonRemovalImpact,
  type OwnerEditorReply,
  type OwnerEditorScope,
  type OwnerGraphCorrectionTarget,
  type OwnerKnowledgeGraphFactAtomicInput,
  type OwnerKnowledgeGraphFactRepository,
  type OwnerMemoryCreationTarget,
  type PreparedOwnerMemoryCreation,
} from '@assistant/persistence';
import type { OwnerEditorDomainPort } from './owner-editor.js';
import { prepareOwnerMemoryCreation, refreshOwnerMemoryCreation } from './owner-memory-create.js';
import {
  type PreparedOwnerMemoryCorrection,
  prepareOwnerMemoryCorrection,
  refreshOwnerMemoryCorrection,
} from './owner-memory-editor.js';
import {
  type OwnerEditorMemoryRemovalSnapshot,
  type PreparedOwnerMemoryRemoval,
  prepareOwnerMemoryRemoval,
  refreshOwnerMemoryRemoval,
} from './owner-memory-removal.js';
import type { EmbeddingPort } from './profile/commands.js';

export interface OwnerEditorContactSnapshot {
  id: string;
  name: string;
  aliases: string[];
  trust: string;
  revision: string;
}
export interface OwnerEditorFamilySnapshot {
  subject: OwnerEditorContactSnapshot;
  object: OwnerEditorContactSnapshot;
  canonicalRevision: string | null;
  canonicalIds?: { assertionId: string; relationId: string; memoryId: string };
  target?: { revision: string; assertionId: string; correction: OwnerGraphCorrectionTarget };
}
export interface OwnerEditorPersonRemovalSnapshot {
  impact: OwnerEditorPersonRemovalImpact;
  contactRevision: string;
}
/** Bounded snapshot adapters on the existing driver; commit rechecks these under its claim lock. */
export interface OwnerEditorDomainStorage {
  memoryCreationTarget?(
    ownerId: string,
    subjectContactId: string,
    contentHash: string,
    scope: OwnerEditorScope,
  ): Promise<OwnerMemoryCreationTarget | null>;
  commitCreateMemory?(
    claim: OwnerEditorClaim,
    prepared: PreparedOwnerMemoryCreation,
    now: Date,
  ): Promise<OwnerEditorReply>;
  contact(ownerId: string, contactId: string): Promise<OwnerEditorContactSnapshot | null>;
  memory?(
    ownerId: string,
    memoryId: string,
    scope: OwnerEditorScope,
  ): Promise<OwnerMemoryEditorSnapshot | null>;
  commitMemory?(
    claim: OwnerEditorClaim,
    prepared: PreparedOwnerMemoryCorrection,
    now: Date,
  ): Promise<OwnerEditorReply>;
  memoryRemovalSnapshot?(
    ownerId: string,
    memoryId: string,
    scope: OwnerEditorScope,
  ): Promise<OwnerEditorMemoryRemovalSnapshot | null>;
  commitMemoryRemoval?(
    claim: OwnerEditorClaim,
    prepared: PreparedOwnerMemoryRemoval,
    now: Date,
  ): Promise<OwnerEditorReply>;
  memoryFollowup?: {
    maintenance: import('@assistant/persistence').ProfileMemoryMaintenance;
    ownerCards: import('@assistant/persistence').OwnerCardCompilationRepository;
  };
  /** Must reject incomplete/raw-limit snapshots and canonical/shared/derived edit scope. */
  family(
    ownerId: string,
    fields: OwnerEditorFamilyFields,
    targetId?: string,
  ): Promise<OwnerEditorFamilySnapshot | null>;
  graph: OwnerKnowledgeGraphFactRepository;
  context(ownerId: string): Promise<{ agentId: string; timeZone: string; locale: string }>;
  commitPerson(
    claim: OwnerEditorClaim,
    prepared: Extract<PreparedOwnerEditor, { kind: 'person' }>,
    now: Date,
  ): Promise<OwnerEditorReply>;
  /** Exact bounded impact and native contact CAS used by preview and commit. */
  personRemovalSnapshot?(
    ownerId: string,
    contactId: string,
    scope: OwnerEditorScope,
  ): Promise<OwnerEditorPersonRemovalSnapshot | null>;
  commitPersonRemoval?(
    claim: OwnerEditorClaim,
    prepared: Extract<PreparedOwnerEditor, { kind: 'person-removal' }>,
    now: Date,
  ): Promise<OwnerEditorReply>;
  /** Operation-scoped source/evidence closure revision for one relationship. */
  familyRemovalRevision?(
    ownerId: string,
    relationId: string,
    scope: OwnerEditorScope,
  ): Promise<string | null>;
  commitFamilyRemoval?(
    claim: OwnerEditorClaim,
    request: Extract<OwnerEditorApply, { command: 'remove_owner_family_relationship' }>,
    now: Date,
  ): Promise<OwnerEditorReply>;
  commitUnchangedFamily(
    claim: OwnerEditorClaim,
    fields: OwnerEditorFamilyFields,
    now: Date,
  ): Promise<OwnerEditorReply>;
  commitFamily(
    claim: OwnerEditorClaim,
    prepared: OwnerKnowledgeGraphFactAtomicInput,
    now: Date,
  ): Promise<OwnerEditorReply>;
}
export type PreparedOwnerEditor =
  | { kind: 'memory-create'; memory: PreparedOwnerMemoryCreation }
  | { kind: 'memory'; memory: PreparedOwnerMemoryCorrection }
  | { kind: 'memory-remove'; memory: PreparedOwnerMemoryRemoval }
  | {
      kind: 'person';
      request: Extract<OwnerEditorApply, { command: 'create_person' | 'update_person_identity' }>;
      name: string;
      aliases: string[];
    }
  | {
      kind: 'person-removal';
      request: Extract<OwnerEditorApply, { command: 'remove_person' }>;
      impact: OwnerEditorPersonRemovalImpact;
    }
  | {
      kind: 'family-removal';
      request: Extract<OwnerEditorApply, { command: 'remove_owner_family_relationship' }>;
    }
  | { kind: 'family-unchanged'; fields: OwnerEditorFamilyFields }
  | {
      kind: 'family';
      atomic: OwnerKnowledgeGraphFactAtomicInput;
      expected: OwnerEditorGraphExpectations;
    };

/** Provider preparation is outside commit; release admission remains a separate gate. */
export function createOwnerEditorDomain(input: {
  storage: OwnerEditorDomainStorage;
  router: EmbeddingPort;
}): OwnerEditorDomainPort<PreparedOwnerEditor> {
  const { storage, router } = input;
  return {
    async prepare(
      request: OwnerEditorApply,
      scope: OwnerEditorScope,
    ): ReturnType<OwnerEditorDomainPort<PreparedOwnerEditor>['prepare']> {
      if (request.command === 'create_owner_memory') {
        if (!storage.memoryCreationTarget || !storage.commitCreateMemory)
          return {
            ok: false,
            result: { outcome: 'unavailable', reason: 'editor_command_unavailable' },
          };
        const result = await prepareOwnerMemoryCreation(
          request,
          scope,
          storage.memoryCreationTarget.bind(storage),
          router,
        );
        return result.ok
          ? { ok: true, prepared: { kind: 'memory-create', memory: result.prepared } }
          : result;
      }
      if (request.command === 'remove_owner_memory') {
        if (!storage.memoryRemovalSnapshot || !storage.commitMemoryRemoval)
          return {
            ok: false,
            result: { outcome: 'unavailable', reason: 'editor_command_unavailable' },
          };
        const result = await prepareOwnerMemoryRemoval(
          request,
          scope,
          storage.memoryRemovalSnapshot.bind(storage),
        );
        return result.ok
          ? { ok: true, prepared: { kind: 'memory-remove', memory: result.prepared } }
          : result;
      }
      const targetMatches =
        request.command === 'create_person'
          ? scope.targetId === null
          : request.command === 'correct_owner_memory'
            ? scope.targetId === request.memoryId
            : request.command === 'update_person_identity'
              ? scope.targetId === request.contactId
              : request.command === 'remove_person'
                ? scope.targetId === request.contactId
                : request.command === 'correct_owner_family_relationship'
                  ? scope.targetId === request.targetRelationId
                  : request.command === 'remove_owner_family_relationship'
                    ? scope.targetId === request.targetRelationId
                    : scope.targetId === request.subjectContactId ||
                      scope.targetId === request.objectContactId;
      if (
        !targetMatches ||
        scope.operationId !== request.operationId ||
        scope.command !== request.command
      )
        return { ok: false, result: { outcome: 'conflict', reason: 'issuance_target_changed' } };
      if (request.command === 'remove_person') {
        if (!storage.personRemovalSnapshot || !storage.commitPersonRemoval)
          return {
            ok: false,
            result: { outcome: 'unavailable', reason: 'person_removal_unavailable' },
          };
        const snapshot = await storage.personRemovalSnapshot(
          scope.ownerId,
          request.contactId,
          scope,
        );
        if (!snapshot)
          return {
            ok: false,
            result: { outcome: 'unavailable', reason: 'person_removal_unavailable' },
          };
        if (
          snapshot.contactRevision !== request.expectedContactRevision ||
          snapshot.impact.contactId !== request.contactId ||
          snapshot.impact.revision !== request.expectedImpactRevision
        )
          return { ok: false, result: { outcome: 'conflict', reason: 'person_impact_changed' } };
        return {
          ok: true,
          prepared: { kind: 'person-removal', request, impact: snapshot.impact },
        };
      }
      if (request.command === 'remove_owner_family_relationship') {
        if (!storage.familyRemovalRevision || !storage.commitFamilyRemoval)
          return {
            ok: false,
            result: { outcome: 'unavailable', reason: 'family_removal_unavailable' },
          };
        const revision = await storage.familyRemovalRevision(
          scope.ownerId,
          request.targetRelationId,
          scope,
        );
        if (!revision)
          return {
            ok: false,
            result: { outcome: 'unavailable', reason: 'family_removal_unavailable' },
          };
        if (revision !== request.expectedTargetRevision)
          return { ok: false, result: { outcome: 'conflict', reason: 'family_target_changed' } };
        return { ok: true, prepared: { kind: 'family-removal', request } };
      }
      if (request.command === 'correct_owner_memory') {
        if (!storage.memory || !storage.commitMemory)
          return {
            ok: false,
            result: { outcome: 'unavailable', reason: 'memory_editor_unavailable' },
          };
        const result = await prepareOwnerMemoryCorrection(
          request,
          scope,
          storage.memory.bind(storage),
          router,
        );
        return result.ok
          ? { ok: true, prepared: { kind: 'memory', memory: result.prepared } }
          : result;
      }
      if (request.command === 'create_person' || request.command === 'update_person_identity') {
        let name: string, aliases: string[];
        try {
          name = normalizeContactName(request.name);
          aliases = normalizeContactAliases(request.aliases, name);
        } catch (error) {
          return {
            ok: false,
            result: {
              outcome: 'invalid',
              fieldErrors: {
                identity: error instanceof Error ? error.message : 'Invalid person identity',
              },
            },
          };
        }
        if (request.command === 'update_person_identity') {
          const current = await storage.contact(scope.ownerId, request.contactId);
          if (
            !current ||
            current.trust === 'owner' ||
            current.revision !== request.expectedContactRevision
          )
            return { ok: false, result: { outcome: 'conflict', reason: 'contact_changed' } };
          try {
            aliases = normalizeContactAliases(
              [
                ...aliases,
                ...(current.name.toLocaleLowerCase() !== name.toLocaleLowerCase()
                  ? [current.name]
                  : []),
              ],
              name,
            );
          } catch (error) {
            return {
              ok: false,
              result: {
                outcome: 'invalid',
                fieldErrors: {
                  aliases: error instanceof Error ? error.message : 'Invalid aliases',
                },
              },
            };
          }
        }
        return { ok: true, prepared: { kind: 'person', request, name, aliases } };
      }
      const fields = request.command === 'add_family_relationship' ? request : request.replacement;
      const targetId =
        request.command === 'correct_owner_family_relationship'
          ? request.targetRelationId
          : undefined;
      const snapshot = await storage.family(scope.ownerId, fields, targetId);
      if (
        !snapshot ||
        snapshot.subject.id !== fields.subjectContactId ||
        snapshot.object.id !== fields.objectContactId ||
        snapshot.subject.id === snapshot.object.id ||
        snapshot.subject.revision !== fields.expectedSubjectRevision ||
        snapshot.object.revision !== fields.expectedObjectRevision
      )
        return { ok: false, result: { outcome: 'conflict', reason: 'family_endpoints_changed' } };
      if (
        request.command === 'correct_owner_family_relationship' &&
        (!snapshot.target || snapshot.target.revision !== request.expectedTargetRevision)
      )
        return { ok: false, result: { outcome: 'conflict', reason: 'family_target_changed' } };
      if (
        (snapshot.canonicalRevision !== null && !snapshot.canonicalIds) ||
        (fields.expectedCanonicalState.kind === 'absent' &&
          snapshot.canonicalRevision !== null &&
          request.command === 'correct_owner_family_relationship' &&
          snapshot.target?.assertionId !== snapshot.canonicalIds?.assertionId) ||
        (fields.expectedCanonicalState.kind === 'revision' &&
          snapshot.canonicalRevision !== fields.expectedCanonicalState.revision)
      )
        return { ok: false, result: { outcome: 'conflict', reason: 'family_canonical_changed' } };
      if (request.command === 'add_family_relationship' && snapshot.canonicalIds)
        return { ok: true, prepared: { kind: 'family-unchanged', fields } };
      const context = await storage.context(scope.ownerId);
      if (context.agentId !== scope.ownerId)
        return { ok: false, result: { outcome: 'conflict', reason: 'owner_changed' } };
      const prepared = await prepareOwnerKnowledgeGraphFactWithRepository(
        {
          repository: storage.graph,
          router,
          agentId: scope.ownerId,
          context: { ...context, contacts: [snapshot.subject, snapshot.object] },
        },
        {
          subject: { label: snapshot.subject.name, kind: 'person', contactId: snapshot.subject.id },
          object: { label: snapshot.object.name, kind: 'person', contactId: snapshot.object.id },
          predicate: fields.predicate,
          note: fields.note,
          validity: fields.validity,
          timing: fields.timing,
        },
        snapshot.target
          ? { target: snapshot.target.correction, disposition: 'whole_fact' }
          : undefined,
      );
      if ('error' in prepared)
        return {
          ok: false,
          result: { outcome: 'invalid', fieldErrors: { family: prepared.error } },
        };
      return {
        ok: true,
        prepared: {
          kind: 'family',
          atomic: prepared.prepared,
          expected: {
            subjectContactRevision: fields.expectedSubjectRevision,
            objectContactRevision: fields.expectedObjectRevision,
            canonical: fields.expectedCanonicalState,
            ...(request.command === 'correct_owner_family_relationship'
              ? {
                  target: {
                    relationId: request.targetRelationId,
                    revision: request.expectedTargetRevision,
                  },
                }
              : {}),
          },
        },
      };
    },
    async commit(claim, prepared, now) {
      if (prepared.kind === 'memory-create') {
        if (!storage.commitCreateMemory) throw new Error('Memory creation writer unavailable');
        const reply = await storage.commitCreateMemory(claim, prepared.memory, now);
        if (
          reply.authority === 'operation_receipt' &&
          reply.outcome === 'saved' &&
          storage.memoryFollowup
        )
          await refreshOwnerMemoryCreation(storage.memoryFollowup.ownerCards, claim.scope.ownerId);
        return reply;
      }
      if (prepared.kind === 'memory') {
        if (!storage.commitMemory) throw new Error('Memory writer unavailable');
        const reply = await storage.commitMemory(claim, prepared.memory, now);
        if (
          reply.authority === 'operation_receipt' &&
          reply.outcome === 'saved' &&
          storage.memoryFollowup
        )
          await refreshOwnerMemoryCorrection(
            storage.memoryFollowup,
            claim.scope.ownerId,
            prepared.memory.memoryId,
          );
        return reply;
      }
      if (prepared.kind === 'memory-remove') {
        if (!storage.commitMemoryRemoval) throw new Error('Memory removal writer unavailable');
        const reply = await storage.commitMemoryRemoval(claim, prepared.memory, now);
        if (
          reply.authority === 'operation_receipt' &&
          reply.outcome === 'saved' &&
          storage.memoryFollowup
        )
          await refreshOwnerMemoryRemoval(
            storage.memoryFollowup,
            claim.scope.ownerId,
            prepared.memory.memoryId,
          );
        return reply;
      }
      return prepared.kind === 'family-unchanged'
        ? storage.commitUnchangedFamily(claim, prepared.fields, now)
        : prepared.kind === 'person-removal'
          ? storage.commitPersonRemoval!(claim, prepared, now)
          : prepared.kind === 'family-removal'
            ? storage.commitFamilyRemoval!(claim, prepared.request, now)
            : prepared.kind === 'person'
              ? storage.commitPerson(claim, prepared, now)
              : storage.commitFamily(
                  claim,
                  { ...prepared.atomic, editor: { claim, expected: prepared.expected } },
                  now,
                );
    },
  };
}

export { createPostgresOwnerEditorDomain } from './profile/commands.js';

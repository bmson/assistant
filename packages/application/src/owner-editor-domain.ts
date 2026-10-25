import { prepareOwnerKnowledgeGraphFactWithRepository } from '@assistant/core/memory/knowledge-graph';
import {
  normalizeContactAliases,
  normalizeContactName,
  type OwnerEditorApply,
  type OwnerEditorClaim,
  type OwnerEditorFamilyFields,
  type OwnerEditorGraphExpectations,
  type OwnerEditorReply,
  type OwnerEditorScope,
  type OwnerGraphCorrectionTarget,
  type OwnerKnowledgeGraphFactAtomicInput,
  type OwnerKnowledgeGraphFactRepository,
} from '@assistant/persistence';
import type { OwnerEditorDomainPort } from './owner-editor.js';
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
/** Bounded snapshot adapters on the existing driver; commit rechecks these under its claim lock. */
export interface OwnerEditorDomainStorage {
  contact(ownerId: string, contactId: string): Promise<OwnerEditorContactSnapshot | null>;
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
  | {
      kind: 'person';
      request: Extract<OwnerEditorApply, { command: 'create_person' | 'update_person_identity' }>;
      name: string;
      aliases: string[];
    }
  | { kind: 'family-unchanged'; fields: OwnerEditorFamilyFields }
  | {
      kind: 'family';
      atomic: OwnerKnowledgeGraphFactAtomicInput;
      expected: OwnerEditorGraphExpectations;
    };

/** Four commands reuse existing source preparation; no provider I/O occurs in commit. */
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
      const targetMatches =
        request.command === 'create_person'
          ? scope.targetId === null
          : request.command === 'update_person_identity'
            ? scope.targetId === request.contactId
            : request.command === 'correct_owner_family_relationship'
              ? scope.targetId === request.targetRelationId
              : scope.targetId === request.subjectContactId ||
                scope.targetId === request.objectContactId;
      if (
        !targetMatches ||
        scope.operationId !== request.operationId ||
        scope.command !== request.command
      )
        return { ok: false, result: { outcome: 'conflict', reason: 'issuance_target_changed' } };
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
    commit(claim, prepared, now) {
      return prepared.kind === 'family-unchanged'
        ? storage.commitUnchangedFamily(claim, prepared.fields, now)
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

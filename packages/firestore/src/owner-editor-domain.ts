import type {
  EmbeddingSpace,
  OwnerEditorClaim,
  OwnerKnowledgeGraphFactAtomicInput,
} from '@assistant/persistence';
import { ownerEditorCommitRevision } from '@assistant/persistence';
import {
  eligibleOwnerFamilyCorrection,
  ownerFamilyCorrectionTarget,
} from '@assistant/persistence/owner-family-scope';
import {
  firestoreOwnerEditorContext,
  readFirestoreOwnerEditorContact,
  readFirestoreOwnerEditorFamily,
} from './owner-editor-graph.js';
import {
  beginFirestoreOwnerEditorWrite,
  completeFirestoreOwnerEditorWrite,
} from './owner-editor-repository.js';
import { FirestoreOwnerKnowledgeGraphFactRepository } from './owner-knowledge-graph-fact.js';
import { FirestoreProfilePeopleCommandRepository } from './profile-people-command.js';
import type { InstallationStore } from './store.js';

/** Structural portable storage adapter; application owns the one domain use case. */
export function createFirestoreOwnerEditorDomainStorage(
  store: InstallationStore,
  ownerId: string,
  embeddingSpace: EmbeddingSpace,
) {
  const graph = new FirestoreOwnerKnowledgeGraphFactRepository(store, embeddingSpace, ownerId);
  const people = new FirestoreProfilePeopleCommandRepository(store, ownerId);
  return {
    graph,
    context: (expected: string) => {
      if (expected !== ownerId) throw new Error('Owner changed');
      return firestoreOwnerEditorContext(store, ownerId);
    },
    contact: (expected: string, id: string) => {
      if (expected !== ownerId) throw new Error('Owner changed');
      return readFirestoreOwnerEditorContact(store, ownerId, id);
    },
    async family(
      expected: string,
      fields: import('@assistant/persistence').OwnerEditorFamilyFields,
      targetId?: string,
    ) {
      if (expected !== ownerId) throw new Error('Owner changed');
      const state = await readFirestoreOwnerEditorFamily(store, ownerId, fields, targetId);
      if (
        !state ||
        state.canonicalConflict ||
        (state.canonicalIds &&
          (!state.canonicalScope || !eligibleOwnerFamilyCorrection(state.canonicalScope)))
      )
        return null;
      const correction = state.target ? ownerFamilyCorrectionTarget(state.target) : null;
      if (targetId && !correction) return null;
      return {
        subject: state.subject,
        object: state.object,
        canonicalRevision: state.canonicalRevision,
        ...(state.canonicalIds ? { canonicalIds: state.canonicalIds } : {}),
        ...(state.target && correction
          ? {
              target: {
                revision: state.target.revision,
                assertionId: state.target.assertion.id,
                correction,
              },
            }
          : {}),
      };
    },
    async commitUnchangedFamily(
      claim: OwnerEditorClaim,
      fields: import('@assistant/persistence').OwnerEditorFamilyFields,
      now: Date,
    ) {
      if (
        claim.scope.command !== 'add_family_relationship' ||
        ![fields.subjectContactId, fields.objectContactId].includes(claim.scope.targetId ?? '')
      )
        throw new Error('Unchanged family operation does not match its claim');
      return store.db.runTransaction(async (tx) => {
        const admitted = await beginFirestoreOwnerEditorWrite(store, tx, claim, now);
        if (admitted.kind === 'reply') return admitted.reply;
        const state = await readFirestoreOwnerEditorFamily(store, ownerId, fields, undefined, tx);
        if (
          !state ||
          !state.canonicalIds ||
          state.canonicalConflict ||
          !state.canonicalScope ||
          !eligibleOwnerFamilyCorrection(state.canonicalScope) ||
          state.subject.revision !== fields.expectedSubjectRevision ||
          state.object.revision !== fields.expectedObjectRevision ||
          (fields.expectedCanonicalState.kind === 'revision' &&
            state.canonicalRevision !== fields.expectedCanonicalState.revision)
        )
          return completeFirestoreOwnerEditorWrite(
            store,
            tx,
            admitted,
            { outcome: 'conflict', reason: 'family_snapshot_changed' },
            now,
          );
        return completeFirestoreOwnerEditorWrite(
          store,
          tx,
          admitted,
          {
            outcome: 'unchanged',
            ids: state.canonicalIds,
            revision: ownerEditorCommitRevision(claim, state.canonicalIds),
          },
          now,
        );
      });
    },
    commitPerson: (
      claim: OwnerEditorClaim,
      prepared: Parameters<typeof people.commitEditor>[1],
      now: Date,
    ) => people.commitEditor(claim, prepared, now),
    async commitFamily(_claim: OwnerEditorClaim, prepared: OwnerKnowledgeGraphFactAtomicInput) {
      if (!prepared.editor) throw new Error('Editor claim required for editor writer');
      const saved = await graph.createAtomic(prepared);
      if (!saved.editorReply) throw new Error('Atomic writer returned no operation receipt');
      return saved.editorReply;
    },
  };
}

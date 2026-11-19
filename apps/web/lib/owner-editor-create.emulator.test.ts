/** Synthetic create, connect, and current-readback proof against an owned Firestore emulator DB. */
import { randomUUID } from 'node:crypto';
import { applyOwnerEditorCommand } from '@assistant/application/owner-editor';
import { createOwnerEditorDomain } from '@assistant/application/owner-editor-domain';
import { matchesPersonSearch } from '@assistant/application/people';
import { projectPersonGraph } from '@assistant/application/people-graph-projection';
import {
  createFirestoreOwnerEditorDomainStorage,
  createFirestoreOwnerEditorOperationRepository,
  firestoreOwnerEditorViewSnapshot,
  getFirestoreKnowledgeGraphOverview,
  getFirestoreKnowledgeGraphRelation,
  getFirestorePersonDetail,
  getFirestorePersonGraph,
  InstallationStore,
  readFirestoreOwnerEditorContact,
  readFirestoreOwnerEditorIssuanceContext,
} from '@assistant/firestore';
import {
  canonicalizeKnowledgeAssertionDirection,
  knowledgeAssertionSemanticKey,
  type OwnerEditorApply,
  type OwnerEditorCommand,
  type OwnerEditorScope,
  ownerEditorPrivacyDigest,
} from '@assistant/persistence';
import { type CollectionReference, FieldPath, Firestore } from '@google-cloud/firestore';
import { OAuth2Client } from 'google-auth-library';
import { afterEach, describe, expect, it } from 'vitest';
import { selectCreatedFamilyPerson } from '../app/people/owner-editor-controls.js';
import { listFirestorePeopleDirectory } from './firestore-people.js';
import { createOwnerEditorHttpHandlers } from './owner-editor-http.js';
import { issueOwnerEditorFormGrant, verifyOwnerEditorHandle } from './owner-editor-scope.js';

const host = process.env.FIRESTORE_EMULATOR_HOST;
const enabled = !!host && /^(127\.0\.0\.1|localhost):\d+$/.test(host);
if (host && !/^(127\.0\.0\.1|localhost):\d+$/.test(host))
  throw new Error('Local Firestore emulator required');

const projectId = 'demo-assistant-test';
const space = { provider: 'test', model: 'fixed-vector', dimensions: 3, revision: '1' };
type Fixture = {
  db: Firestore;
  store: InstallationStore;
  ownerId: string;
  epoch: string;
  session: { ownerId: string; formSessionScope: string };
  secret: string;
  operations: ReturnType<typeof createFirestoreOwnerEditorOperationRepository>;
  domain: ReturnType<typeof createOwnerEditorDomain>;
  grant(
    command: OwnerEditorCommand,
    targetId: string | null,
  ): Promise<{
    operationId: string;
    issuedOperationHandle: string;
    scope: OwnerEditorScope;
  }>;
  post(
    path: '/api/people/editor' | '/api/profile/knowledge/family',
    grant: { issuedOperationHandle: string },
    request: OwnerEditorApply,
  ): Promise<unknown>;
};

type Receipt = {
  authority: 'operation_receipt';
  command: OwnerEditorCommand;
  operationId: string;
  outcome: 'saved' | 'unchanged';
  ids: { contactId?: string; relationId?: string; assertionId?: string; memoryId?: string };
};

function assertReceipt(
  value: unknown,
  command: OwnerEditorCommand,
  operationId: string,
): asserts value is Receipt {
  if (
    typeof value !== 'object' ||
    !value ||
    !('authority' in value) ||
    value.authority !== 'operation_receipt' ||
    !('command' in value) ||
    value.command !== command ||
    !('operationId' in value) ||
    value.operationId !== operationId ||
    !('outcome' in value) ||
    (value.outcome !== 'saved' && value.outcome !== 'unchanged') ||
    !('ids' in value) ||
    typeof value.ids !== 'object' ||
    !value.ids
  )
    throw new Error('Actual editor response was not the expected canonical receipt');
}

async function fixture(): Promise<Fixture> {
  if (!host || !enabled) throw new Error('Local people-creation emulator required');
  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  const databaseId = `people-create-${nonce}`;
  const db = new Firestore({
    projectId,
    databaseId,
    host,
    ssl: false,
    universeDomain: 'googleapis.com',
    preferRest: true,
    authClient: new OAuth2Client({
      universeDomain: 'googleapis.com',
      credentials: { access_token: 'owner', expiry_date: Number.MAX_SAFE_INTEGER },
    }),
  } as ConstructorParameters<typeof Firestore>[0]);
  try {
    const store = new InstallationStore(
      db,
      `people-create-test-${nonce}`,
      undefined,
      projectId,
      databaseId,
    );
    const ownerId = randomUUID();
    const epoch = randomUUID();
    await store.doc('agents', ownerId).set({ id: ownerId, timezone: 'UTC', locale: 'en' });
    await store.doc('maintenanceCursors', `owner-editor-epoch:${ownerId}`).set({
      name: `owner-editor-epoch:${ownerId}`,
      cursor: JSON.stringify({
        ownerId,
        epoch,
        privacyGenerationDigest: ownerEditorPrivacyDigest(null),
        ready: true,
      }),
    });
    const router = {
      embeddingSpace: async () => space,
      embed: async (texts: string[]) => texts.map(() => [1, 0, 0]),
    };
    const domain = createOwnerEditorDomain({
      storage: createFirestoreOwnerEditorDomainStorage(store, ownerId, space),
      router,
    });
    const operations = createFirestoreOwnerEditorOperationRepository(store, ownerId);
    const session = { ownerId, formSessionScope: `people-create-${nonce}-session` };
    const secret = `synthetic-${nonce}-owner-editor-secret`;
    const origin = 'https://people-create.example.test';
    const grant = async (command: OwnerEditorCommand, targetId: string | null) => {
      const context = await readFirestoreOwnerEditorIssuanceContext(store, ownerId);
      if (!context) throw new Error('Fresh owner issuance context was not readable');
      const issued = issueOwnerEditorFormGrant({ context, session, command, targetId, secret });
      const verified = verifyOwnerEditorHandle({
        token: issued.issuedOperationHandle,
        session,
        secret,
      });
      if (verified.kind !== 'verified') throw new Error('Synthetic form handle did not verify');
      return { ...issued, scope: verified.scope };
    };
    const post = async (
      path: '/api/people/editor' | '/api/profile/knowledge/family',
      issued: { issuedOperationHandle: string },
      request: OwnerEditorApply,
    ) => {
      const handlers = createOwnerEditorHttpHandlers(path, {
        authenticate: async () => ({ formSessionScope: session.formSessionScope }),
        resolveOwnerId: async () => ownerId,
        origin,
        secret,
        withBackend: async (_scope, run) =>
          run({
            operations,
            apply: (body, scope) =>
              applyOwnerEditorCommand({ request: body, scope, operations, domain }),
          }),
      });
      const response = await handlers.POST(
        new Request(`${origin}${path}`, {
          method: 'POST',
          headers: {
            origin,
            'content-type': 'application/json',
            'x-editor-session-scope': session.formSessionScope,
            'x-editor-form-scope': issued.issuedOperationHandle,
          },
          body: JSON.stringify(request),
        }),
      );
      return response.json();
    };
    return { db, store, ownerId, epoch, session, secret, operations, domain, grant, post };
  } catch (setupError) {
    const cleanupErrors: unknown[] = [];
    try {
      await clearOwnedDatabase(db);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await db.terminate();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0)
      throw new AggregateError([setupError, ...cleanupErrors], 'Fixture setup and cleanup failed');
    throw setupError;
  }
}

async function clearOwnedDatabase(db: Firestore): Promise<void> {
  const collections = await db.listCollections();
  if (collections.length > 32) throw new Error('Owned emulator cleanup collection bound exceeded');
  let deleted = 0;
  for (const collection of collections as CollectionReference[]) {
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    for (;;) {
      let query = collection.orderBy(FieldPath.documentId()).limit(400);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      deleted += page.size;
      if (deleted > 2_000) throw new Error('Owned emulator cleanup document bound exceeded');
      const batch = db.batch();
      for (const doc of page.docs) batch.delete(doc.ref);
      await batch.commit();
      if (page.size < 400) break;
      cursor = page.docs.at(-1);
    }
  }
  for (const collection of collections as CollectionReference[]) {
    if (!(await collection.limit(1).get()).empty)
      throw new Error('Owned emulator cleanup left a document behind');
  }
}

describe.skipIf(!enabled)('people creation and family connection on actual Firestore SDK', () => {
  let active: Fixture | undefined;

  afterEach(async () => {
    if (!active) return;
    try {
      await clearOwnedDatabase(active.db);
    } finally {
      await active.db.terminate();
      active = undefined;
    }
  });

  it('creates through directory and inline grants, then rereads a directed family connection and receipt', async () => {
    const f = await fixture();
    active = f;

    // The People directory's scoped create grant crosses the strict HTTP parser and real domain.
    const directoryGrant = await f.grant('create_person', null);
    const directoryRequest: OwnerEditorApply = {
      version: 1,
      intent: 'apply',
      command: 'create_person',
      operationId: directoryGrant.operationId,
      name: 'Directory Created Rowan',
      aliases: ['Rowan Test'],
    };
    const directoryReceipt = await f.post('/api/people/editor', directoryGrant, directoryRequest);
    assertReceipt(directoryReceipt, 'create_person', directoryGrant.operationId);
    expect(directoryReceipt).toMatchObject({
      authority: 'operation_receipt',
      command: 'create_person',
      operationId: directoryGrant.operationId,
      outcome: 'saved',
    });
    if (typeof directoryReceipt.ids.contactId !== 'string')
      throw new Error('Directory create receipt omitted its canonical contact ID');
    const directoryId = directoryReceipt.ids.contactId;
    expect(await f.post('/api/people/editor', directoryGrant, directoryRequest)).toEqual(
      directoryReceipt,
    );

    // Fresh directory/search and native detail reads use the current SDK-backed repositories.
    const directory = await listFirestorePeopleDirectory(f.store, f.ownerId, new Date());
    const directoryPerson = directory.find((person) => person.id === directoryId);
    if (!directoryPerson) throw new Error('Fresh directory omitted the created person');
    expect(directoryPerson?.aliases).toEqual(['Rowan Test']);
    const searchResults = directory.filter((person) => matchesPersonSearch(person, 'rowan test'));
    expect(searchResults.map((person) => person.id)).toEqual([directoryId]);
    expect(
      matchesPersonSearch({ ...directoryPerson, aliases: undefined }, 'directory created'),
    ).toBe(true);
    expect(matchesPersonSearch({ ...directoryPerson, aliases: undefined }, 'rowan test')).toBe(
      false,
    );
    expect(await getFirestorePersonDetail(f.store, f.ownerId, directoryId)).toMatchObject({
      id: directoryId,
      name: 'Directory Created Rowan',
      trust: 'known',
    });

    // The inline editor uses the owner-editor create command and returns its saved ID to the free endpoint.
    const inlineGrant = await f.grant('create_person', null);
    const inlineRequest: OwnerEditorApply = {
      version: 1,
      intent: 'apply',
      command: 'create_person',
      operationId: inlineGrant.operationId,
      name: 'Inline Created Casey',
      aliases: ['Casey Test'],
    };
    const inlineReceipt = await f.post('/api/people/editor', inlineGrant, inlineRequest);
    assertReceipt(inlineReceipt, 'create_person', inlineGrant.operationId);
    expect(inlineReceipt).toMatchObject({
      authority: 'operation_receipt',
      command: 'create_person',
      operationId: inlineGrant.operationId,
      outcome: 'saved',
    });
    if (typeof inlineReceipt.ids.contactId !== 'string')
      throw new Error('Inline create did not return a saved contact ID');
    const inlineId = inlineReceipt.ids.contactId;
    expect(await f.post('/api/people/editor', inlineGrant, inlineRequest)).toEqual(inlineReceipt);
    const inlineContact = await readFirestoreOwnerEditorContact(f.store, f.ownerId, inlineId);
    expect(inlineContact).toMatchObject({
      id: inlineId,
      name: 'Inline Created Casey',
      trust: 'known',
    });

    const familySnapshot = await firestoreOwnerEditorViewSnapshot(f.store, f.ownerId, {
      contactId: directoryId,
    });
    const anchor = familySnapshot.people.find((person) => person.contactId === directoryId);
    const created = familySnapshot.people.find((person) => person.contactId === inlineId);
    if (!anchor || !created) throw new Error('Fresh family selector omitted a created endpoint');
    const selected = selectCreatedFamilyPerson(
      { subject: directoryId, object: '' },
      directoryId,
      inlineId,
    );
    expect(selected).toEqual({ subject: directoryId, object: inlineId });
    const familyGrant = await f.grant('add_family_relationship', directoryId);
    const familyRequest: OwnerEditorApply = {
      version: 1,
      intent: 'apply',
      command: 'add_family_relationship',
      operationId: familyGrant.operationId,
      subjectContactId: selected.subject,
      objectContactId: selected.object,
      expectedSubjectRevision: anchor.revision,
      expectedObjectRevision: created.revision,
      predicate: 'parent_of',
      timing: 'present',
      validity: { validFrom: null, validUntil: null },
      note: 'Synthetic owner-recorded family connection.',
      expectedCanonicalState: { kind: 'absent' },
    };
    const familyReceipt = await f.post('/api/profile/knowledge/family', familyGrant, familyRequest);
    assertReceipt(familyReceipt, 'add_family_relationship', familyGrant.operationId);
    expect(familyReceipt).toMatchObject({
      authority: 'operation_receipt',
      command: 'add_family_relationship',
      outcome: 'saved',
    });
    if (typeof familyReceipt.ids.relationId !== 'string')
      throw new Error('Family commit returned no canonical relation ID');
    const relationId = familyReceipt.ids.relationId;

    const [relation, parentGraph, childGraph, parentDetail, childDetail] = await Promise.all([
      getFirestoreKnowledgeGraphRelation(f.store, f.ownerId, 1, relationId, new Date(), space),
      getFirestorePersonGraph(f.store, f.ownerId, directoryId, 1, new Date(), space),
      getFirestorePersonGraph(f.store, f.ownerId, inlineId, 1, new Date(), space),
      getFirestorePersonDetail(f.store, f.ownerId, directoryId),
      getFirestorePersonDetail(f.store, f.ownerId, inlineId),
    ]);
    expect(relation).toMatchObject({
      id: relationId,
      subject: { label: 'Directory Created Rowan', kind: 'person' },
      predicate: 'parent_of',
      object: { label: 'Inline Created Casey', kind: 'person' },
      source: { ownerConfirmed: true },
    });
    expect(parentGraph?.edges).toContainEqual(
      expect.objectContaining({ id: relationId, predicate: 'parent_of', outbound: true }),
    );
    expect(childGraph?.edges).toContainEqual(
      expect.objectContaining({ id: relationId, predicate: 'parent_of', outbound: false }),
    );
    expect(parentDetail?.name).toBe('Directory Created Rowan');
    expect(childDetail?.name).toBe('Inline Created Casey');
    const parentProjection = projectPersonGraph(
      'Directory Created Rowan',
      parentGraph?.edges ?? [],
    );
    const childProjection = projectPersonGraph('Inline Created Casey', childGraph?.edges ?? []);
    const parentSentence = parentProjection.relations.find(
      (edge) => edge.id === relationId,
    )?.sentence;
    const childSentence = childProjection.relations.find(
      (edge) => edge.id === relationId,
    )?.sentence;
    expect(parentSentence).toContain('Directory Created Rowan');
    expect(parentSentence).toContain('Inline Created Casey');
    expect(parentSentence).toBe(
      "Recorded statement: Directory Created Rowan is Inline Created Casey's parent. Timing recorded: present. Recorded dates: Start and end not recorded.",
    );
    expect(childSentence).toBe(parentSentence);

    const subjectEntityId = relation?.subject.id;
    const objectEntityId = relation?.object.id;
    if (!subjectEntityId || !objectEntityId)
      throw new Error('Canonical relation omitted an endpoint entity');
    const meaning = (
      subjectEntityId: string,
      predicate: 'parent_of' | 'child_of',
      objectEntityId: string,
    ) =>
      canonicalizeKnowledgeAssertionDirection({
        subjectEntityId,
        predicate,
        objectEntityId,
        assertion: { tense: 'present', polarity: 'positive', modality: 'asserted' },
        validFrom: null,
        validUntil: null,
      });
    expect(
      knowledgeAssertionSemanticKey(
        f.ownerId,
        meaning(subjectEntityId, 'parent_of', objectEntityId),
      ),
    ).toBe(
      knowledgeAssertionSemanticKey(
        f.ownerId,
        meaning(objectEntityId, 'child_of', subjectEntityId),
      ),
    );
    const map = await getFirestoreKnowledgeGraphOverview(
      f.store,
      f.ownerId,
      1,
      { entityId: subjectEntityId, page: 1, pageSize: 25 },
      new Date(),
      25,
      space,
    );
    expect(map.relations).toContainEqual(
      expect.objectContaining({ id: relationId, inRecall: true }),
    );

    const replay = await f.post('/api/profile/knowledge/family', familyGrant, familyRequest);
    expect(replay).toEqual(familyReceipt);
    expect(
      await getFirestoreKnowledgeGraphRelation(
        f.store,
        f.ownerId,
        1,
        relationId,
        new Date(),
        space,
      ),
    ).toEqual(relation);
    const currentDirectory = await listFirestorePeopleDirectory(f.store, f.ownerId, new Date());
    expect(currentDirectory.some((person) => person.id === inlineId)).toBe(true);
  });
});

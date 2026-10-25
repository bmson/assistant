import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyOwnerEditorCommand } from '@assistant/application/owner-editor';
import { createOwnerEditorDomain } from '@assistant/application/owner-editor-domain';
import { presentOwnerFamilyFact } from '@assistant/application/relationship-presentation';
import { envFile } from '@assistant/config';
import {
  type OwnerEditorApply,
  type OwnerEditorCommand,
  type OwnerEditorReceiptReply,
  ownerEditorPrivacyDigest,
} from '@assistant/persistence';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ownerEditorRequestHash } from '../../../packages/application/src/owner-editor-hash';
import { createFirestoreOwnerEditorDomainStorage } from '../../../packages/firestore/src/owner-editor-domain';
import {
  firestoreOwnerEditorViewSnapshot,
  readFirestoreOwnerEditorContact,
  readFirestoreOwnerEditorGraphScope,
} from '../../../packages/firestore/src/owner-editor-graph';
import {
  createFirestoreOwnerEditorOperationRepository,
  readFirestoreOwnerEditorIssuanceContext,
} from '../../../packages/firestore/src/owner-editor-repository';
import { ownerEditorTestStore } from '../../../packages/firestore/src/owner-editor-test-store';
import { decodeRecord } from '../../../packages/firestore/src/store';
import { type OwnerEditorStorage, readOwnerEditorPendingMarker } from './owner-editor-client';
import { createOwnerEditorHttpHandlers } from './owner-editor-http';
import { OwnerEditorOperation } from './owner-editor-operation';
import { issueOwnerEditorFormGrant } from './owner-editor-scope';

// Vitest awaits this BEFORE static imports of config/application/driver modules.
// A normal CI invocation needs no caller-only environment or setup command.
const isolation = await vi.hoisted(async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const url = await import('node:url');
  const repo = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
  const parent = path.join(repo, '.artifacts/b2-source/pipeline-fixtures');
  await fs.mkdir(parent, { recursive: true });
  const owned = await fs.mkdtemp(path.join(parent, 'case-'));
  const config = path.join(owned, 'config'),
    tmp = path.join(owned, 'tmp');
  await fs.mkdir(config);
  await fs.mkdir(tmp);
  // Only path metadata is retained for restoration; no credentials/MCP values read.
  const previousRoot = process.env.ASSISTANT_REPO_ROOT,
    previousTmp = process.env.TMPDIR;
  process.env.ASSISTANT_REPO_ROOT = config;
  process.env.TMPDIR = tmp;
  return { owned, config, tmp, previousRoot, previousTmp };
});
if (envFile !== join(isolation.config, '.env') || existsSync(envFile))
  throw Error('Pipeline isolation must precede actual config imports');
afterAll(async () => {
  if (isolation.previousRoot === undefined) delete process.env.ASSISTANT_REPO_ROOT;
  else process.env.ASSISTANT_REPO_ROOT = isolation.previousRoot;
  if (isolation.previousTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = isolation.previousTmp;
  const fs = await import('node:fs/promises');
  await fs.rm(isolation.owned, { recursive: true, force: false });
});

class MarkerStorage implements OwnerEditorStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
function fixture() {
  const f = ownerEditorTestStore();
  const ownerId = randomUUID(),
    epoch = randomUUID(),
    existingId = randomUUID();
  const clock = Date.now();
  const session = { ownerId, formSessionScope: 'offline_pipeline_owner_session' };
  const secret = 'offline-pipeline-hmac-fixture-not-live-config';
  const origin = 'https://offline-pipeline.example.test';
  f.seed('agents', ownerId, { id: ownerId, timezone: 'Pacific/Auckland', locale: 'en' });
  f.seed('maintenanceCursors', `owner-editor-epoch:${ownerId}`, {
    name: `owner-editor-epoch:${ownerId}`,
    cursor: JSON.stringify({
      ownerId,
      epoch,
      privacyGenerationDigest: ownerEditorPrivacyDigest(null),
      ready: true,
    }),
  });
  f.seed('contacts', existingId, {
    id: existingId,
    agentId: ownerId,
    name: 'Sam Example',
    aliases: [],
    relationship: '',
    trust: 'unknown',
    emails: [],
    phones: [],
    notes: '',
    createdAt: new Date(clock),
    updatedAt: new Date(clock),
  });
  const space = { provider: 'offline-test', model: 'fixed-vector', dimensions: 3, revision: '1' };
  const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]));
  const domain = createOwnerEditorDomain({
    storage: createFirestoreOwnerEditorDomainStorage(f.store, ownerId, space),
    router: { embeddingSpace: async () => space, embed },
  });
  const operations = createFirestoreOwnerEditorOperationRepository(f.store, ownerId);
  const handlers = (path: '/api/people/editor' | '/api/profile/knowledge/family') =>
    createOwnerEditorHttpHandlers(path, {
      authenticate: async () => ({ formSessionScope: session.formSessionScope }),
      resolveOwnerId: async () => ownerId,
      origin,
      secret,
      now: () => clock,
      withBackend: async (_scope, run) =>
        run({
          operations,
          apply: (request, scope) =>
            applyOwnerEditorCommand({
              request,
              scope,
              operations,
              domain,
              now: () => new Date(clock),
            }),
        }),
    });
  const trace: { method: string; path: string }[] = [];
  const replies: unknown[] = [];
  let dropNextPost = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), origin);
    if (
      url.origin !== origin ||
      !['/api/people/editor', '/api/profile/knowledge/family'].includes(url.pathname)
    )
      throw Error('Unexpected offline pipeline route');
    const request = new Request(url, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init?.headers)), origin },
    });
    trace.push({ method: request.method, path: url.pathname });
    const factory = handlers(
      url.pathname as '/api/people/editor' | '/api/profile/knowledge/family',
    );
    const response =
      request.method === 'GET'
        ? await factory.GET(request)
        : request.method === 'POST'
          ? await factory.POST(request)
          : (() => {
              throw Error('Unexpected pipeline method');
            })();
    const observed = await response.clone().json();
    replies.push(observed);
    // Fault is strictly AFTER the real factory/coordinator/storage commit and
    // response construction. No writer/domain result is mocked.
    if (request.method === 'POST' && dropNextPost) {
      dropNextPost = false;
      throw Error('Simulated lost HTTP response after committed pipeline');
    }
    return response;
  };
  const storage = new MarkerStorage();
  const controller = () => {
    const c = new OwnerEditorOperation(session, () => storage, fetcher);
    c.initialize();
    return c;
  };
  const grant = async (command: OwnerEditorCommand, targetId: string | null) => {
    const context = await readFirestoreOwnerEditorIssuanceContext(f.store, ownerId);
    if (!context) throw Error('Fixture epoch must be read through actual issuance adapter');
    return issueOwnerEditorFormGrant({ context, session, command, targetId, secret, now: clock });
  };
  const marker = () => readOwnerEditorPendingMarker(storage, ownerId, session.formSessionScope);
  return {
    ...f,
    ownerId,
    existingId,
    session,
    embed,
    controller,
    storage,
    grant,
    marker,
    trace,
    replies,
    fetcher,
    drop: () => {
      dropNextPost = true;
    },
  };
}
function saved(
  controller: OwnerEditorOperation,
): OwnerEditorReceiptReply & { outcome: 'saved' | 'unchanged' } {
  const state = controller.getSnapshot();
  expect(state.phase, JSON.stringify(state)).toBe('resolved');
  if (
    state.reply?.authority !== 'operation_receipt' ||
    !['saved', 'unchanged'].includes(state.reply.outcome)
  )
    throw Error(`Expected real saved receipt: ${JSON.stringify(state)}`);
  return state.reply as OwnerEditorReceiptReply & { outcome: 'saved' | 'unchanged' };
}
async function createKnown(f: ReturnType<typeof fixture>, controller: OwnerEditorOperation) {
  const grant = await f.grant('create_person', null);
  await controller.apply(
    {
      version: 1,
      intent: 'apply',
      command: grant.command,
      operationId: grant.operationId,
      name: 'Alex Example',
      aliases: ['Alex'],
    },
    grant,
    null,
  );
  const result = saved(controller);
  const id = result.ids.contactId;
  if (!id) throw Error('Actual create must return contact ID');
  const native = await readFirestoreOwnerEditorContact(f.store, f.ownerId, id);
  if (!native) throw Error('Actual committed contact must reread');
  expect(native.trust).toBe('known');
  expect(native.revision).not.toBe(result.revision);
  return { result, id, native };
}
async function familyRequest(f: ReturnType<typeof fixture>, leftId: string) {
  const snapshot = await firestoreOwnerEditorViewSnapshot(f.store, f.ownerId, {
    contactId: leftId,
  });
  const left = snapshot.people.find((p) => p.contactId === leftId),
    right = snapshot.people.find((p) => p.contactId === f.existingId);
  if (!left || !right) throw Error('Actual bounded options must contain both named contacts');
  const grant = await f.grant('add_family_relationship', leftId);
  const body: Extract<OwnerEditorApply, { command: 'add_family_relationship' }> = {
    version: 1,
    intent: 'apply',
    command: 'add_family_relationship',
    operationId: grant.operationId,
    subjectContactId: left.contactId,
    objectContactId: right.contactId,
    expectedSubjectRevision: left.revision,
    expectedObjectRevision: right.revision,
    predicate: 'parent_of',
    timing: 'past',
    validity: { validFrom: '2024-02-29', validUntil: '2024-02-29' },
    note: 'Explicit owner-recorded leap-day statement',
    expectedCanonicalState: { kind: 'absent' },
  };
  const preview = presentOwnerFamilyFact({
    ...body,
    subjectLabel: left.name,
    objectLabel: right.name,
  });
  return { snapshot, grant, body, preview };
}

describe('offline actual controller → HTTP → coordinator/domain → FS repository/canonical writer pipeline', () => {
  it('creates known contact, edits unknown identity without trust promotion, saves/replays family and corrects sole owner source', async () => {
    const f = fixture(),
      controller = f.controller();
    const created = await createKnown(f, controller);
    expect(f.marker()).toBeNull();
    expect(f.embed).not.toHaveBeenCalled();
    const unknown = await readFirestoreOwnerEditorContact(f.store, f.ownerId, f.existingId);
    if (!unknown) throw Error('Expected existing unknown contact');
    const identityGrant = await f.grant('update_person_identity', f.existingId);
    controller.acceptFreshSnapshot([identityGrant]);
    await controller.apply(
      {
        version: 1,
        intent: 'apply',
        command: 'update_person_identity',
        operationId: identityGrant.operationId,
        contactId: f.existingId,
        expectedContactRevision: unknown.revision,
        name: 'Sam Renamed',
        aliases: [],
      },
      identityGrant,
      f.existingId,
    );
    saved(controller);
    const renamed = await readFirestoreOwnerEditorContact(f.store, f.ownerId, f.existingId);
    expect(renamed).toMatchObject({ name: 'Sam Renamed', trust: 'unknown' });
    expect(renamed?.aliases).toContain('Sam Example');
    if (!renamed) throw Error('Renamed native contact must exist');
    const family = await familyRequest(f, created.id);
    controller.acceptFreshSnapshot([family.grant]);
    await controller.apply(family.body, family.grant, created.id);
    const familySaved = saved(controller);
    const relationId = familySaved.ids.relationId;
    if (!relationId) throw Error('Actual canonical save must return relation ID');
    const point = await readFirestoreOwnerEditorGraphScope(f.store, f.ownerId, relationId);
    if (!point) throw Error('Actual saved graph/source must reread');
    expect(point.source.content).toBe(family.preview);
    expect(point.relation.assertionId).toBe(point.assertion.id);
    expect(point.relation.sourceMemoryId).toBe(point.source.id);
    expect(familySaved.ids.assertionId).toBe(point.assertion.id);
    expect(point.relation).toMatchObject({
      validFrom: '2024-02-29',
      validUntil: '2024-02-29',
      assertion: { tense: 'past' },
    });
    const memory = decodeRecord<{ validFrom: Date; validUntil: Date }>(f.rows('memories')[0]);
    expect(memory.validFrom.toISOString()).toBe('2024-02-29T00:00:00.000Z');
    expect(memory.validUntil.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    expect(
      f.rows('ownerEditorOperations').find((row) => row.operationId === family.grant.operationId)
        ?.requestHash,
    ).toBe(ownerEditorRequestHash(family.body));
    expect(f.embed).toHaveBeenCalledTimes(1);
    const beforeRows = ['memories', 'knowledgeGraphRelations', 'knowledgeGraphAssertions'].map(
      (table) => f.rows(table).length,
    );
    const replay = await f.fetcher('/api/profile/knowledge/family', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Editor-Session-Scope': f.session.formSessionScope,
        'X-Editor-Form-Scope': family.grant.issuedOperationHandle,
      },
      body: JSON.stringify(family.body),
    });
    expect(await replay.json()).toEqual(familySaved);
    expect(
      ['memories', 'knowledgeGraphRelations', 'knowledgeGraphAssertions'].map(
        (table) => f.rows(table).length,
      ),
    ).toEqual(beforeRows);
    expect(f.embed).toHaveBeenCalledTimes(1);
    const snapshot = await firestoreOwnerEditorViewSnapshot(f.store, f.ownerId, {
      contactId: created.id,
      relationIds: [relationId],
    });
    const eligible = snapshot.corrections[0];
    if (!eligible) throw Error('Actual sole-owner canonical source must be eligible');
    expect(eligible.revision).toBe(point.revision);
    expect(eligible.sourceText).toBe(family.preview);
    const correctionGrant = await f.grant('correct_owner_family_relationship', relationId);
    controller.acceptFreshSnapshot([correctionGrant]);
    const replacement = {
      ...eligible.original,
      predicate: 'partner_of',
      timing: 'past' as const,
      validity: { validFrom: null, validUntil: null },
      note: 'Owner correction',
      expectedCanonicalState: { kind: 'absent' as const },
    };
    await controller.apply(
      {
        version: 1,
        intent: 'apply',
        command: 'correct_owner_family_relationship',
        operationId: correctionGrant.operationId,
        targetRelationId: relationId,
        expectedTargetRevision: eligible.revision,
        replacement,
      },
      correctionGrant,
      relationId,
    );
    const corrected = saved(controller);
    expect(corrected.ids.previousRelationId).toBe(relationId);
    if (!corrected.ids.relationId)
      throw Error('Correction must return its actual replacement relation');
    const replacementPoint = await readFirestoreOwnerEditorGraphScope(
      f.store,
      f.ownerId,
      corrected.ids.relationId,
    );
    if (!replacementPoint) throw Error('Corrected source/canonical relation must reread');
    expect(replacementPoint.source.content).toBe(
      presentOwnerFamilyFact({
        ...replacement,
        subjectLabel: created.native.name,
        objectLabel: renamed.name,
      }),
    );
    expect(replacementPoint.relation.assertionId).toBe(replacementPoint.assertion.id);
    expect(replacementPoint.assertion.id).not.toBe(point.assertion.id);

    expect(f.embed).toHaveBeenCalledTimes(2);
    expect(f.rows('memories')).toHaveLength(2);
    expect((await readFirestoreOwnerEditorContact(f.store, f.ownerId, f.existingId))?.trust).toBe(
      'unknown',
    );
    expect(f.stats.readsAfterWrites).toBe(0);
    expect(f.stats.unboundedQueries).toEqual([]);
  });

  it.each(['create_person', 'add_family_relationship'] as const)(
    'lost %s response AFTER actual commit restores opaque old marker, GET receipt clears with no new write/embed',
    async (command) => {
      const f = fixture(),
        first = f.controller();
      let grant: Awaited<ReturnType<typeof f.grant>>,
        body: OwnerEditorApply,
        targetId: string | null;
      if (command === 'create_person') {
        grant = await f.grant(command, null);
        targetId = null;
        body = {
          version: 1,
          intent: 'apply',
          command,
          operationId: grant.operationId,
          name: 'Lost response named contact',
          aliases: [],
        };
      } else {
        const created = await createKnown(f, first);
        const family = await familyRequest(f, created.id);
        grant = family.grant;
        body = family.body;
        targetId = created.id;
        first.acceptFreshSnapshot([grant]);
      }
      f.drop();
      await first.apply(body, grant, targetId);
      expect(first.getSnapshot().phase).toBe('pending');
      const marker = f.marker();
      expect(marker?.id).toBe(grant.issuedOperationHandle);
      const serialized = [...f.storage.values.values()][0] ?? '';
      expect(Object.keys(JSON.parse(serialized)).sort()).toEqual(['command', 'id', 'targetId']);
      expect(serialized).not.toContain(
        command === 'create_person'
          ? 'Lost response named contact'
          : 'Explicit owner-recorded leap-day statement',
      );
      const postCount = f.trace.filter((event) => event.method === 'POST').length,
        embedCount = f.embed.mock.calls.length;
      const committed = f
        .rows('ownerEditorOperations')
        .find((row) => row.operationId === grant.operationId);
      expect(committed?.status).toBe('committed');
      const restored = f.controller();
      expect(restored.getSnapshot().phase).toBe('pending');
      const temptingNewGrant = await f.grant(command, targetId);
      await restored.apply(
        { ...body, operationId: temptingNewGrant.operationId },
        temptingNewGrant,
        targetId,
      );
      expect(f.trace.filter((event) => event.method === 'POST')).toHaveLength(postCount);
      await restored.check();
      const receipt = saved(restored);
      expect(receipt.operationId).toBe(grant.operationId);
      expect(f.marker()).toBeNull();
      expect(f.trace.at(-1)?.method).toBe('GET');
      expect(f.trace.filter((event) => event.method === 'POST')).toHaveLength(postCount);
      expect(f.embed).toHaveBeenCalledTimes(embedCount);
      const id =
        receipt.ids.contactId ??
        (body.command === 'add_family_relationship' ? body.subjectContactId : undefined);
      if (!id) throw Error('Need actual contact to reread native CAS');
      const native = await readFirestoreOwnerEditorContact(f.store, f.ownerId, id);
      expect(native?.revision).not.toBe(receipt.revision);
      expect(restored.getSnapshot().phase).toBe('resolved'); // Receipt does not auto-enable another edit.
      const fresh = await f.grant('update_person_identity', id);
      restored.acceptFreshSnapshot([fresh]);
      expect(restored.getSnapshot().phase).toBe('ready');
      expect(f.stats.readsAfterWrites).toBe(0);
      expect(f.stats.unboundedQueries).toEqual([]);
    },
  );
});

import {
  ownerEditorCanonicalApply,
  parseOwnerEditorRequest,
} from '@assistant/application/owner-editor-wire';
import type { OwnerEditorFormGrant, OwnerEditorReply } from '@assistant/persistence/owner-editor';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownerEditorRequestHash } from '../../../packages/application/src/owner-editor-hash';
import {
  clearOwnerEditorPendingMarker,
  decodeOwnerEditorReply,
  type OwnerEditorStorage,
  readOwnerEditorPendingMarker,
  writeOwnerEditorPendingMarker,
} from './owner-editor-client';
import {
  OwnerEditorOperation,
  ownerEditorOutcomeMessage,
  ownerEditorUncertaintyMessage,
} from './owner-editor-operation';

const op = '11111111-1111-4111-8111-111111111111';
const nextOp = '44444444-4444-4444-8444-444444444444';
const contact = '22222222-2222-4222-8222-222222222222';
const second = '55555555-5555-4555-8555-555555555555';
const relation = '66666666-6666-4666-8666-666666666666';
const session = {
  ownerId: '33333333-3333-4333-8333-333333333333',
  formSessionScope: 'owner-session-fixture',
};
const grant: OwnerEditorFormGrant = {
  command: 'create_person',
  operationId: op,
  issuedOperationHandle: 'old-issued-handle',
};
class Storage implements OwnerEditorStorage {
  values = new Map<string, string>();
  failWrite = false;
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrite) throw Error('storage denied');
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
const saved = (overrides = {}) => ({
  version: 1,
  authority: 'operation_receipt',
  command: grant.command,
  operationId: op,
  requestHash: hash,
  statusVersion: 2,
  outcome: 'saved',
  ids: { contactId: contact },
  revision: 'b'.repeat(64),
  ...overrides,
});
const unknown = (extra = {}) => ({
  version: 1,
  authority: 'unresolved',
  command: grant.command,
  operationId: op,
  outcome: 'outcome_unknown',
  reason: 'receipt_missing',
  ...extra,
});
const response = (value: unknown) => Response.json(value);
const apply = (g = grant) => ({
  version: 1,
  intent: 'apply',
  command: g.command,
  operationId: g.operationId,
  name: 'Sam',
  aliases: ['Samuel'],
});
function validatedHash(value: unknown) {
  const parsed = parseOwnerEditorRequest(value, '/api/people/editor');
  if (!parsed.ok || parsed.request.intent !== 'apply') throw Error('Invalid hash fixture');
  return ownerEditorRequestHash(parsed.request);
}
const hash = validatedHash(apply());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function fixture() {
  const storage = new Storage();
  const fetcher = vi.fn<typeof fetch>();
  const controller = new OwnerEditorOperation(session, () => storage, fetcher);
  controller.initialize();
  return { storage, fetcher, controller };
}
const pending = (storage: Storage) =>
  readOwnerEditorPendingMarker(storage, session.ownerId, session.formSessionScope);

describe('actual owner editor operation controller with offline named transport', () => {
  it.each(['add_family_relationship', 'correct_owner_family_relationship'] as const)(
    'keeps unknown %s pending and checks its result without sending another save',
    async (command) => {
      const f = fixture();
      const familyGrant = { ...grant, command };
      const familyFields = {
        subjectContactId: contact,
        objectContactId: second,
        expectedSubjectRevision: 'a'.repeat(64),
        expectedObjectRevision: 'b'.repeat(64),
        predicate: 'parent_of',
        timing: 'unspecified' as const,
        validity: { validFrom: null, validUntil: null },
        note: '',
        expectedCanonicalState: { kind: 'absent' as const },
      };
      const value = {
        version: 1,
        intent: 'apply',
        command,
        operationId: op,
        ...(command === 'add_family_relationship'
          ? familyFields
          : {
              targetRelationId: relation,
              expectedTargetRevision: 'c'.repeat(64),
              replacement: familyFields,
            }),
      };
      const path = '/api/profile/knowledge/family';
      const parsed = parseOwnerEditorRequest(value, path);
      if (!parsed.ok || parsed.request.intent !== 'apply') throw Error('Invalid family fixture');
      f.fetcher.mockRejectedValueOnce(Error('response lost'));
      await f.controller.apply(
        value,
        familyGrant,
        command === 'add_family_relationship' ? contact : relation,
      );
      expect(f.controller.getSnapshot().phase).toBe('pending');
      expect(f.controller.getSnapshot().message).toBe(ownerEditorUncertaintyMessage(command));
      expect(f.controller.getSnapshot().message).not.toBe('Saving…');
      const originalMarker = pending(f.storage);
      const storageBeforeReload = [...f.storage.values];
      const reloaded = new OwnerEditorOperation(session, () => f.storage, f.fetcher);
      reloaded.initialize();
      expect(reloaded.getSnapshot().message).toBe(ownerEditorUncertaintyMessage(command, true));
      expect(reloaded.getSnapshot().marker).toEqual(originalMarker);
      expect([...f.storage.values]).toEqual(storageBeforeReload);
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      await f.controller.apply(
        value,
        familyGrant,
        command === 'add_family_relationship' ? contact : relation,
      );
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      expect(pending(f.storage)?.command).toBe(command);
      f.fetcher.mockResolvedValueOnce(
        response(
          saved({
            command,
            requestHash: ownerEditorRequestHash(parsed.request),
            ids: { relationId: relation, memoryId: contact, assertionId: second },
          }),
        ),
      );
      await f.controller.checkPendingResult();
      expect(f.fetcher).toHaveBeenCalledTimes(2);
      expect(f.fetcher.mock.calls[1]?.[1]?.method ?? 'GET').toBe('GET');
      expect(f.controller.getSnapshot().phase).toBe('resolved');
      expect(f.controller.getSnapshot().message).toBe('Saved.');
      expect(pending(f.storage)).toBeNull();
    },
  );
  it.each(['remove_person', 'remove_owner_family_relationship'] as const)(
    'does not create a pending operation for unsupported %s commands',
    async (command) => {
      const { controller, storage, fetcher } = fixture();
      const unsupported = { ...grant, command };
      const value =
        command === 'remove_person'
          ? {
              version: 1,
              intent: 'apply',
              command,
              operationId: op,
              contactId: contact,
              expectedContactRevision: 'a'.repeat(64),
              expectedImpactRevision: 'b'.repeat(64),
            }
          : {
              version: 1,
              intent: 'apply',
              command,
              operationId: op,
              targetRelationId: relation,
              expectedTargetRevision: 'c'.repeat(64),
            };
      await controller.apply(value, unsupported, command === 'remove_person' ? contact : relation);
      expect(controller.getSnapshot().phase).toBe('ready');
      expect(Object.keys(controller.getSnapshot().fieldErrors)).not.toHaveLength(0);
      expect(controller.getSnapshot().message).toBe('Check the highlighted fields.');
      expect(storage.values.size).toBe(0);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it('calls browser fetch through the global receiver on the default transport path', async () => {
    const storage = new Storage();
    const browserFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(response(saved()));
    });
    vi.stubGlobal('fetch', browserFetch);
    const controller = new OwnerEditorOperation(session, () => storage);
    controller.initialize();

    await controller.apply(apply(), grant, null);

    expect(browserFetch).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'resolved', busy: false });
  });
  it('validates with the actual shared parser before marker or dispatch', async () => {
    const { controller, storage, fetcher } = fixture();
    await controller.apply({ ...apply(), name: '' }, grant, null);
    expect(controller.getSnapshot().fieldErrors.name).toBeTruthy();
    expect(storage.values.size).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe('ready');
  });
  it('rejects actual invalid family civil dates locally with zero marker/write', async () => {
    const { controller, storage, fetcher } = fixture();
    const familyGrant = { ...grant, command: 'add_family_relationship' as const };
    await controller.apply(
      {
        version: 1,
        intent: 'apply',
        command: familyGrant.command,
        operationId: op,
        subjectContactId: contact,
        objectContactId: second,
        expectedSubjectRevision: hash,
        expectedObjectRevision: hash,
        predicate: 'parent_of',
        timing: 'unspecified',
        validity: { validFrom: '2025-02-29', validUntil: null },
        note: '',
        expectedCanonicalState: { kind: 'absent' },
      },
      familyGrant,
      contact,
    );
    expect(controller.getSnapshot().fieldErrors['validity.validFrom']).toBeTruthy();
    expect(storage.values.size).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('persists only opaque metadata before POST; complete committed refresh-pending stays saved', async () => {
    const { controller, storage, fetcher } = fixture();
    fetcher.mockImplementation(async (_url, options) => {
      expect(pending(storage)).toEqual({
        id: grant.issuedOperationHandle,
        command: grant.command,
        targetId: null,
      });
      expect([...storage.values.values()][0]).not.toContain('Samuel');
      expect(options?.headers).toEqual({
        'X-Editor-Session-Scope': session.formSessionScope,
        'X-Editor-Form-Scope': grant.issuedOperationHandle,
        'Content-Type': 'application/json',
      });
      return response(saved({ refreshPending: true }));
    });
    await controller.apply(apply(), grant, null);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/people/editor');
    expect(controller.getSnapshot().message).toBe(
      'Saved. Some derived details still need to refresh.',
    );
    expect(controller.getSnapshot().phase).toBe('resolved');
    expect(pending(storage)).toBeNull();
  });
  it('storage failure prevents any dispatch', async () => {
    const { controller, storage, fetcher } = fixture();
    storage.failWrite = true;
    await controller.apply(apply(), grant, null);
    expect(fetcher).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe('blocked');
  });
  it('a sibling control reserving after initialization is adopted, not overwritten or dispatched', async () => {
    const { controller, storage, fetcher } = fixture();
    const old = {
      id: 'sibling-original-handle',
      command: 'create_person' as const,
      targetId: null,
    };
    writeOwnerEditorPendingMarker(storage, session.ownerId, session.formSessionScope, old);
    await controller.apply(apply(), grant, null);
    expect(fetcher).not.toHaveBeenCalled();
    expect(pending(storage)).toEqual(old);
    expect(controller.getSnapshot().phase).toBe('pending');
    expect(controller.getSnapshot().marker).toEqual(old);
  });
  it('connection loss locks both old and new IDs; missing GET does not unlock', async () => {
    const { controller, storage, fetcher } = fixture();
    fetcher
      .mockRejectedValueOnce(Error('lost response'))
      .mockResolvedValueOnce(response(unknown()));
    await controller.apply(apply(), grant, null);
    await controller.apply(
      apply({ ...grant, operationId: nextOp }),
      { ...grant, operationId: nextOp },
      null,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    await controller.check();
    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/people/editor?operation=old-issued-handle');
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe('GET');
    expect(controller.getSnapshot().phase).toBe('pending');
    expect(pending(storage)).not.toBeNull();
  });
  it('reload looks up the old opaque handle, learns its original UUID, never a new grant UUID', async () => {
    const storage = new Storage();
    writeOwnerEditorPendingMarker(storage, session.ownerId, session.formSessionScope, {
      id: grant.issuedOperationHandle,
      command: grant.command,
      targetId: null,
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(saved()));
    const reloaded = new OwnerEditorOperation(session, () => storage, fetcher);
    reloaded.initialize();
    reloaded.acceptFreshSnapshot([
      { ...grant, operationId: nextOp, issuedOperationHandle: 'new-form-handle' },
    ]);
    expect(reloaded.getSnapshot().phase).toBe('pending');
    await reloaded.check();
    expect(fetcher.mock.calls[0]?.[0]).toContain('operation=old-issued-handle');
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      'X-Editor-Form-Scope': 'old-issued-handle',
    });
    expect(reloaded.getSnapshot().phase).toBe('resolved');
    expect(pending(storage)).toBeNull();
  });
  it('an incoming request rejection never clears original A; authoritative readback A resolves it', async () => {
    const { controller, storage, fetcher } = fixture();
    fetcher
      .mockResolvedValueOnce(
        response({
          version: 1,
          authority: 'request_rejection',
          command: grant.command,
          operationId: op,
          outcome: 'conflict',
          originalOperationTerminal: false,
          reason: 'request_hash_mismatch',
        }),
      )
      .mockResolvedValueOnce(response(saved()));
    await controller.apply(apply(), grant, null);
    expect(controller.getSnapshot().phase).toBe('pending');
    expect(pending(storage)).not.toBeNull();
    await controller.check();
    expect(controller.getSnapshot().phase).toBe('resolved');
  });
  it('explicit reconciliation sends only original UUID and proof, no private body/new operation', async () => {
    const { controller, fetcher } = fixture();
    fetcher
      .mockRejectedValueOnce(Error('connection lost'))
      .mockResolvedValueOnce(
        response(
          unknown({ receiptBindingToken: 'authenticated-original-proof', reason: 'preparing' }),
        ),
      )
      .mockResolvedValueOnce(response(saved()));
    await controller.apply(apply(), grant, null);
    await controller.check();
    expect(controller.canReconcile()).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2); // No automatic POST reconciliation.
    await controller.reconcile();
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({
      version: 1,
      intent: 'reconcile',
      command: grant.command,
      operationId: op,
      receiptBindingToken: 'authenticated-original-proof',
    });
    expect(controller.getSnapshot().phase).toBe('resolved');
  });
  it('late response A cannot clear externally installed marker B', async () => {
    const { controller, storage, fetcher } = fixture();
    let finish!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const running = controller.apply(apply(), grant, null);
    await vi.waitFor(() => expect(pending(storage)).not.toBeNull());
    const markerA = pending(storage);
    if (!markerA) throw new Error('Expected original marker before held response');
    expect(
      clearOwnerEditorPendingMarker(
        storage,
        session.ownerId,
        session.formSessionScope,
        markerA,
        decodeOwnerEditorReply(saved()),
        op,
        hash,
      ),
    ).toBe(true);
    const markerB = { ...markerA, id: 'new-issued-B-handle' };
    writeOwnerEditorPendingMarker(storage, session.ownerId, session.formSessionScope, markerB);
    finish(response(saved()));
    await running;
    expect(pending(storage)).toEqual(markerB);
    expect(controller.getSnapshot().marker).toEqual(markerB);
    expect(controller.getSnapshot().phase).toBe('pending');
  });
  it.each([
    {},
    saved({ ids: {} }),
    saved({ ids: { contactId: '' } }),
    saved({ revision: 'not-CAS-or-hash' }),
    saved({ operationId: 'wrong' }),
    saved({ operationId: nextOp }),
  ])('malformed/foreign fulfilled reply keeps pending (%j)', async (bad) => {
    const { controller, storage, fetcher } = fixture();
    fetcher.mockResolvedValue(response(bad));
    await controller.apply(apply(), grant, null);
    expect(controller.getSnapshot().phase).toBe('pending');
    expect(pending(storage)).not.toBeNull();
  });
  it('a terminal receipt never supplies record CAS or unlocks another write before a fresh server snapshot', async () => {
    const { controller, fetcher } = fixture();
    fetcher.mockResolvedValue(response(saved()));
    await controller.apply(apply(), grant, null);
    const newGrant = {
      ...grant,
      operationId: nextOp,
      issuedOperationHandle: 'fresh-issued-handle',
    };
    await controller.apply(apply(newGrant), newGrant, null);
    expect(fetcher).toHaveBeenCalledTimes(1);
    controller.acceptFreshSnapshot([grant]);
    expect(controller.getSnapshot().phase).toBe('resolved');
    controller.acceptFreshSnapshot([newGrant]);
    expect(controller.getSnapshot().phase).toBe('ready');
    await controller.apply(apply(), grant, null);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    'update_person_identity',
    'add_family_relationship',
    'correct_owner_family_relationship',
  ] as const)(
    'dispatches the actual typed %s command on its sole declared path',
    async (command) => {
      const { controller, fetcher } = fixture();
      const g = { ...grant, command };
      const fields = {
        subjectContactId: contact,
        objectContactId: second,
        expectedSubjectRevision: hash,
        expectedObjectRevision: hash,
        predicate: 'parent_of',
        timing: 'unspecified',
        validity: { validFrom: null, validUntil: null },
        note: '',
        expectedCanonicalState: { kind: 'absent' },
      };
      const envelope = { version: 1, intent: 'apply', command, operationId: op };
      const body =
        command === 'update_person_identity'
          ? {
              ...envelope,
              contactId: contact,
              expectedContactRevision: hash,
              name: 'Sam',
              aliases: [],
            }
          : command === 'add_family_relationship'
            ? { ...envelope, ...fields }
            : {
                ...envelope,
                targetRelationId: relation,
                expectedTargetRevision: hash,
                replacement: fields,
              };
      fetcher.mockResolvedValue(response(unknown({ command })));
      await controller.apply(
        body,
        g,
        command === 'correct_owner_family_relationship' ? relation : contact,
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]?.[0]).toBe(
        command === 'update_person_identity'
          ? '/api/people/editor'
          : '/api/profile/knowledge/family',
      );
      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(body);
    },
  );
});

describe('owner editor outcome copy preserves authority distinctions', () => {
  it('does not claim a failed save for unresolved or retired-scope outcomes', () => {
    const unresolved = ownerEditorOutcomeMessage(unknown() as OwnerEditorReply);
    const retired = ownerEditorOutcomeMessage({
      version: 1,
      authority: 'scope_retirement',
      command: grant.command,
      operationId: op,
      outcome: 'voided',
      reason: 'scope_retired',
    });
    expect(unresolved).toContain('could not be confirmed');
    expect(unresolved).not.toContain('not applied');
    expect(retired).toContain('does not confirm whether its save happened');
    expect(retired).not.toContain('not applied');
  });
  it('uses terminal unavailable receipt wording without repeated draft-retention claims', () => {
    const message = ownerEditorOutcomeMessage(
      saved({ outcome: 'unavailable', reason: 'owner_editor_unavailable' }) as OwnerEditorReply,
    );
    expect(message).toBe('This save was not applied. Editing is unavailable.');
    expect(message).not.toContain('draft');
  });
});

describe('independent live request identity and explicit conflict review', () => {
  it('same UUID/command terminal receipt with wrong hash cannot clear or be learned from later GET', async () => {
    const { controller, storage, fetcher } = fixture();
    fetcher
      .mockResolvedValueOnce(response(saved({ requestHash: 'f'.repeat(64) })))
      .mockResolvedValueOnce(response(saved({ requestHash: 'f'.repeat(64) })))
      .mockResolvedValueOnce(response(saved()));
    await controller.apply(apply(), grant, null);
    expect(controller.getSnapshot().phase).toBe('pending');
    expect(pending(storage)).not.toBeNull();
    expect(controller.getSnapshot().reply).toBeNull();
    await controller.check();
    expect(controller.getSnapshot().phase).toBe('pending');
    await controller.check();
    expect(controller.getSnapshot().phase).toBe('resolved');
    expect(pending(storage)).toBeNull();
  });
  it('async hashing locks admission before marker creation and prevents concurrent second POST', async () => {
    const parsed = parseOwnerEditorRequest(apply(), '/api/people/editor');
    if (!parsed.ok || parsed.request.intent !== 'apply') throw Error('Invalid hash fixture');
    const actualDigest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(ownerEditorCanonicalApply(parsed.request)),
    );
    // Digest is held only to test admission ordering; the resulting hash is not
    // used as success authority in this case (transport deliberately fails).
    let release!: (bytes: ArrayBuffer) => void;
    const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { controller, storage, fetcher } = fixture();
    fetcher.mockRejectedValue(Error('offline transport loss'));
    const first = controller.apply(apply(), grant, null);
    const secondGrant = { ...grant, operationId: nextOp };
    const secondApply = controller.apply(apply(secondGrant), secondGrant, null);
    expect(storage.values.size).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(controller.getSnapshot().busy).toBe(true);
    expect(digest).toHaveBeenCalledTimes(1);
    release(actualDigest);
    await Promise.all([first, secondApply]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(pending(storage)?.id).toBe(grant.issuedOperationHandle);
  });
  it('unavailable browser crypto fails before marker or network', async () => {
    const { controller, storage, fetcher } = fixture();
    vi.stubGlobal('crypto', undefined);
    await controller.apply(apply(), grant, null);
    expect(controller.getSnapshot().phase).toBe('blocked');
    expect(storage.values.size).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('recovers an expired preparing claim through GET proof and same-operation reconciliation', async () => {
    const storage = new Storage();
    writeOwnerEditorPendingMarker(storage, session.ownerId, session.formSessionScope, {
      id: grant.issuedOperationHandle,
      command: grant.command,
      targetId: null,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(
          unknown({
            reason: 'preparing',
            receiptBindingToken: 'original-proof',
          }),
        ),
      )
      .mockResolvedValueOnce(
        response({
          version: 1,
          authority: 'operation_receipt',
          command: grant.command,
          operationId: op,
          requestHash: hash,
          statusVersion: 2,
          outcome: 'not_applied',
          reason: 'preparation_failed',
        }),
      );
    const controller = new OwnerEditorOperation(session, () => storage, fetcher);
    controller.initialize();
    await controller.checkPendingResult();
    expect(controller.getSnapshot().message).not.toContain('Your draft is kept');
    expect(controller.canReconcile()).toBe(true);
    await controller.checkPendingResult();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'resolved',
      reviewRequired: false,
      reply: { authority: 'operation_receipt', outcome: 'not_applied' },
    });
    expect(pending(storage)).toBeNull();
    expect(fetcher.mock.calls.map((call) => call[1]?.method)).toEqual(['GET', 'POST']);
    const reconciliation = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(reconciliation).toEqual({
      version: 1,
      intent: 'reconcile',
      command: grant.command,
      operationId: op,
      receiptBindingToken: 'original-proof',
    });
    expect(JSON.stringify(reconciliation)).not.toContain('Sam');
    const fresh = {
      ...grant,
      operationId: nextOp,
      issuedOperationHandle: 'fresh-after-retirement',
    };
    expect(controller.acceptFreshSnapshot([fresh])).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', reviewRequired: false });
  });
  it('conflict remains locked across fresh props until explicit same-command review, then uses reviewed CAS', async () => {
    const { controller, fetcher } = fixture();
    const identityGrant: OwnerEditorFormGrant = { ...grant, command: 'update_person_identity' };
    const identityApply = {
      ...apply(),
      command: identityGrant.command,
      contactId: contact,
      expectedContactRevision: 'c'.repeat(64),
    };
    // Strict conflict wire has no successful receipt fields.
    fetcher.mockResolvedValueOnce(
      response({
        version: 1,
        authority: 'operation_receipt',
        command: identityGrant.command,
        operationId: op,
        requestHash: validatedHash(identityApply),
        statusVersion: 2,
        outcome: 'conflict',
        reason: 'contact_changed',
      }),
    );
    await controller.apply(identityApply, identityGrant, contact);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'resolved', reviewRequired: true });
    const fresh = {
      ...identityGrant,
      operationId: nextOp,
      issuedOperationHandle: 'fresh-reviewed-handle',
    };
    expect(controller.acceptFreshSnapshot([fresh])).toBe(false);
    expect(controller.getSnapshot().reviewRequired).toBe(true);
    await controller.apply(
      { ...identityApply, operationId: fresh.operationId, expectedContactRevision: 'd'.repeat(64) },
      fresh,
      contact,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(controller.reviewFreshSnapshot([{ ...fresh, command: 'create_person' }])).toBe(false);
    expect(controller.reviewFreshSnapshot([identityGrant])).toBe(false);
    expect(controller.reviewFreshSnapshot([fresh])).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', reviewRequired: false });
  });
});

describe('command-specific uncertainty remains uncertainty', () => {
  it.each([
    ['create_person', 'Save', 'saving again'],
    ['update_person_identity', 'Save', 'saving again'],
    ['add_family_relationship', 'Save', 'saving again'],
    ['correct_owner_family_relationship', 'Save', 'saving again'],
    ['correct_owner_memory', 'Save', 'saving again'],
  ] as const)('formats original and restored %s with its own action', (command, subject, next) => {
    expect(ownerEditorUncertaintyMessage(command)).toBe(
      `${subject} could not be confirmed. Check its result before ${next}.`,
    );
    expect(ownerEditorUncertaintyMessage(command, true)).toBe(
      `An earlier ${subject.toLowerCase()} could not be confirmed. Check its result before ${next}.`,
    );
    const reply = unknown({ command }) as OwnerEditorReply;
    expect(ownerEditorOutcomeMessage(reply)).toBe(ownerEditorUncertaintyMessage(command));
    expect(ownerEditorOutcomeMessage(reply)).not.toMatch(
      /was deleted|was removed|not applied|success/,
    );
  });
  it.each([
    ['remove_person', 'the person was deleted'],
    ['remove_owner_family_relationship', 'the connection was removed'],
  ] as const)('retired %s scope never confirms that its action happened', (command, action) => {
    const message = ownerEditorOutcomeMessage({
      version: 1,
      authority: 'scope_retirement',
      command,
      operationId: op,
      outcome: 'voided',
      reason: 'scope_retired',
    });
    expect(message).toContain(`does not confirm whether ${action}`);
    expect(message).not.toContain('its save happened');
  });
});

it('does not guess a removal or save when an untrusted reply has no command', () => {
  expect(ownerEditorUncertaintyMessage(null)).toBe(
    'Operation could not be confirmed. Check its result before trying again.',
  );
});

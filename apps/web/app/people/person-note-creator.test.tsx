import { webcrypto } from 'node:crypto';
import { parseOwnerEditorRequest } from '@assistant/application/owner-editor-wire';
import type { OwnerEditorFormGrant, OwnerEditorReply } from '@assistant/persistence/owner-editor';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OwnerEditorStorage } from '@/lib/owner-editor-client';
import { OwnerEditorOperation, type OwnerEditorOperationState } from '@/lib/owner-editor-operation';
import { ownerEditorRequestHash } from '../../../../packages/application/src/owner-editor-hash';
import {
  buildPersonNoteCreateRequest,
  canReviewPersonNoteDraft,
  hasFreshPersonNoteGrant,
  type PersonNoteCreateSnapshot,
  PersonNoteCreator,
  PersonNoteRecovery,
  PersonNoteResultStatus,
  personNoteCreateConflictMessage,
  personNoteCreatedMemoryId,
  personNoteDraftAfterFreshReview,
  personNoteDraftFreshnessAction,
} from './person-note-creator';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const ownerId = '11111111-1111-4111-8111-111111111111';
const subjectId = '22222222-2222-4222-8222-222222222222';
const memoryId = '33333333-3333-4333-8333-333333333333';
const operationId = '44444444-4444-4444-8444-444444444444';
const nextOperationId = '55555555-5555-4555-8555-555555555555';
const session = { ownerId, formSessionScope: 'person-note-test-session-01' };
const snapshot: PersonNoteCreateSnapshot = {
  contactId: subjectId,
  name: 'Alex Example',
  trust: 'known',
  revision: 'a'.repeat(64),
};
const grant: OwnerEditorFormGrant = {
  command: 'create_owner_memory',
  operationId,
  issuedOperationHandle: 'opaque-signed-form-handle',
};
const content = 'Alex prefers morning meetings.';

class MemoryStorage implements OwnerEditorStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  all() {
    return [...this.values.values()];
  }
}

function createRequest(g = grant) {
  return buildPersonNoteCreateRequest({
    session,
    snapshot,
    grant: g,
    content,
    domain: 'relationships',
    importance: 3,
    pinned: false,
  });
}

function receipt(
  overrides: Partial<Extract<OwnerEditorReply, { authority: 'operation_receipt' }>> = {},
): OwnerEditorReply {
  const request = createRequest();
  if (!request) throw Error('Expected valid note request');
  return {
    version: 1,
    authority: 'operation_receipt',
    command: 'create_owner_memory',
    operationId,
    requestHash: ownerEditorRequestHash(request),
    statusVersion: 2,
    outcome: 'saved',
    ids: { memoryId },
    revision: 'b'.repeat(64),
    ...overrides,
  } as OwnerEditorReply;
}

function operationState(patch: Partial<OwnerEditorOperationState> = {}): OwnerEditorOperationState {
  return {
    phase: 'resolved',
    reviewRequired: false,
    reviewTargetId: subjectId,
    marker: null,
    busy: false,
    reply: receipt(),
    fieldErrors: {},
    message: 'Saved.',
    ...patch,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dormant person-note request and receipt contract', () => {
  it('allows stale-draft review only for the captured person with a fresh revision and grant', () => {
    const capture = { session, snapshot, grant };
    expect(
      canReviewPersonNoteDraft({
        capture,
        session,
        snapshot: { ...snapshot, contactId: memoryId, revision: 'c'.repeat(64) },
        grant: { ...grant, operationId: nextOperationId, issuedOperationHandle: 'fresh-handle' },
        phase: 'ready',
      }),
    ).toBe(false);
    expect(
      canReviewPersonNoteDraft({
        capture,
        session,
        snapshot: { ...snapshot, revision: 'c'.repeat(64) },
        grant: { ...grant, operationId: nextOperationId, issuedOperationHandle: 'fresh-handle' },
        phase: 'ready',
      }),
    ).toBe(true);
  });

  it('keeps refresh available for stale A, and offers review only for same A with a new grant', () => {
    const capture = { session, snapshot, grant };
    const staleA = { ...snapshot, revision: 'c'.repeat(64) };
    expect(
      personNoteDraftFreshnessAction({
        capture,
        session,
        snapshot: staleA,
        grant,
        phase: 'ready',
      }),
    ).toBe('refresh');
    expect(
      personNoteDraftFreshnessAction({
        capture,
        session,
        snapshot: { ...staleA, contactId: memoryId },
        grant: { ...grant, operationId: nextOperationId, issuedOperationHandle: 'fresh-handle' },
        phase: 'ready',
      }),
    ).toBeNull();
    expect(
      personNoteDraftFreshnessAction({
        capture,
        session,
        snapshot: staleA,
        grant: { ...grant, operationId: nextOperationId, issuedOperationHandle: 'fresh-handle' },
        phase: 'ready',
      }),
    ).toBe('review');
  });

  it('keeps the original draft and sends no create when the current person changes', async () => {
    // Pure guard/controller model; the dormant component is not mounted in this test.
    vi.stubGlobal('crypto', webcrypto);
    const fetcher = vi.fn<typeof fetch>();
    const storage = new MemoryStorage();
    const controller = new OwnerEditorOperation(session, () => storage, fetcher);
    controller.initialize();
    const originalDraft = content;
    const capture = { session, snapshot, grant };
    const action = personNoteDraftFreshnessAction({
      capture,
      session,
      snapshot: { ...snapshot, contactId: memoryId, revision: 'c'.repeat(64) },
      grant: { ...grant, operationId: nextOperationId, issuedOperationHandle: 'fresh-handle' },
      phase: controller.getSnapshot().phase,
    });
    if (action === 'review') await controller.apply(createRequest(), grant, subjectId);
    expect(action).toBeNull();
    expect(originalDraft).toBe(content);
    expect(controller.getSnapshot().phase).toBe('ready');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('builds only the strict existing create command with subject revision and normalized content', () => {
    const request = createRequest();
    expect(request).toEqual({
      version: 1,
      intent: 'apply',
      command: 'create_owner_memory',
      operationId,
      subjectContactId: subjectId,
      expectedSubjectRevision: snapshot.revision,
      content,
      domain: 'relationships',
      importance: 3,
      pinned: false,
    });
    const parsed = parseOwnerEditorRequest(request, '/api/profile/knowledge/memory');
    expect(parsed.ok).toBe(true);
    expect(
      parseOwnerEditorRequest({ ...request, targetId: subjectId }, '/api/profile/knowledge/memory')
        .ok,
    ).toBe(false);
  });

  it.each([
    { session: { ...session, ownerId: subjectId } },
    { snapshot: { ...snapshot, trust: 'owner' } },
    { snapshot: { ...snapshot, trust: ' ' } },
    { snapshot: { ...snapshot, revision: 'not-a-revision' } },
    { grant: { ...grant, command: 'correct_owner_memory' as const } },
    { content: '  x ' },
  ])('refuses an invalid person, grant, revision, or note shape', (patch) => {
    expect(
      buildPersonNoteCreateRequest({
        session,
        snapshot,
        grant,
        content,
        domain: 'relationships',
        importance: 3,
        pinned: false,
        ...patch,
      } as Parameters<typeof buildPersonNoteCreateRequest>[0]),
    ).toBeNull();
  });

  it('names only the new memory from the original controller-validated saved receipt', () => {
    const savedState = operationState();
    expect(personNoteCreatedMemoryId(savedState, grant)).toBe(memoryId);
    expect(personNoteDraftAfterFreshReview(savedState, grant, content)).toBe('');
    expect(
      personNoteCreatedMemoryId(
        operationState({ reply: receipt({ outcome: 'unchanged' }) }),
        grant,
      ),
    ).toBeNull();
    expect(
      personNoteCreatedMemoryId(
        operationState({ reply: receipt({ operationId: nextOperationId }) }),
        grant,
      ),
    ).toBeNull();
    expect(
      personNoteCreatedMemoryId(
        operationState({ reply: receipt({ ids: { memoryId: subjectId } }) }),
        grant,
      ),
    ).toBeNull();
    expect(
      personNoteDraftAfterFreshReview(
        operationState({ reply: receipt({ outcome: 'conflict', reason: 'revision_changed' }) }),
        grant,
        content,
      ),
    ).toBe(content);
  });

  it('keeps an unknown create pending after reload and checks only the original operation', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const request = createRequest();
    if (!request) throw Error('Expected valid note request');
    const storage = new MemoryStorage();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(Error('connection lost'))
      .mockResolvedValueOnce(
        Response.json({
          version: 1,
          authority: 'unresolved',
          command: 'create_owner_memory',
          operationId,
          outcome: 'outcome_unknown',
          reason: 'receipt_missing',
        }),
      )
      .mockResolvedValueOnce(Response.json(receipt()));
    const original = new OwnerEditorOperation(session, () => storage, fetcher);
    original.initialize();
    await original.apply(request, grant, subjectId);
    expect(original.getSnapshot().phase).toBe('pending');
    expect(storage.all()).toEqual([
      JSON.stringify({
        id: grant.issuedOperationHandle,
        command: grant.command,
        targetId: subjectId,
      }),
    ]);
    expect(storage.all().join('')).not.toContain(content);

    const reloaded = new OwnerEditorOperation(session, () => storage, fetcher);
    reloaded.initialize();
    expect(reloaded.getSnapshot()).toMatchObject({
      phase: 'pending',
      marker: { targetId: subjectId },
    });
    await reloaded.checkPendingResult();
    expect(reloaded.getSnapshot().phase).toBe('pending');
    await reloaded.checkPendingResult();
    expect(reloaded.getSnapshot()).toMatchObject({ phase: 'resolved', reviewTargetId: subjectId });
    expect(personNoteCreatedMemoryId(reloaded.getSnapshot(), null)).toBe(memoryId);
    expect(fetcher.mock.calls.map((call) => call[1]?.method)).toEqual(['POST', 'GET', 'GET']);
  });

  it('requires an explicit fresh person-bound grant after a conflict or recovered save', () => {
    const state = operationState();
    const nextGrant = {
      ...grant,
      operationId: nextOperationId,
      issuedOperationHandle: 'next-handle',
    };
    expect(
      hasFreshPersonNoteGrant({
        state,
        previousOperationId: operationId,
        session,
        snapshot: { ...snapshot, revision: 'c'.repeat(64) },
        grant: nextGrant,
      }),
    ).toBe(true);
    expect(
      hasFreshPersonNoteGrant({
        state,
        previousOperationId: operationId,
        session,
        snapshot,
        grant,
      }),
    ).toBe(false);
    expect(
      hasFreshPersonNoteGrant({
        state: operationState({
          reply: receipt({ outcome: 'conflict', reason: 'revision_changed' }),
        }),
        previousOperationId: operationId,
        session,
        snapshot: { ...snapshot, revision: 'c'.repeat(64) },
        grant: nextGrant,
      }),
    ).toBe(true);
  });

  it.each(['unchanged', 'operation', 'hash', 'malformed'] as const)(
    'keeps %s replies pending instead of treating them as this note saved',
    async (kind) => {
      vi.stubGlobal('crypto', webcrypto);
      const request = createRequest();
      if (!request) throw Error('Expected valid note request');
      const badReceipt =
        kind === 'unchanged'
          ? receipt({ outcome: 'unchanged' })
          : kind === 'operation'
            ? receipt({ operationId: nextOperationId })
            : kind === 'hash'
              ? receipt({ requestHash: 'f'.repeat(64) })
              : { malformed: true };
      const fetcher = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(Error('connection lost'))
        .mockResolvedValueOnce(Response.json(badReceipt));
      const storage = new MemoryStorage();
      const controller = new OwnerEditorOperation(session, () => storage, fetcher);
      controller.initialize();
      await controller.apply(request, grant, subjectId);
      await controller.checkPendingResult();

      expect(controller.getSnapshot().phase).toBe('pending');
      expect(controller.getSnapshot().marker).toMatchObject({ command: 'create_owner_memory' });
      expect(personNoteCreatedMemoryId(controller.getSnapshot(), grant)).toBeNull();
      expect(fetcher.mock.calls.map((call) => call[1]?.method)).toEqual(['POST', 'GET']);
    },
  );

  it('blocks dispatch when session storage cannot persist the original operation marker', async () => {
    const request = createRequest();
    if (!request) throw Error('Expected valid note request');
    const storage: OwnerEditorStorage = {
      getItem: () => null,
      setItem: () => {
        throw Error('storage denied');
      },
      removeItem: () => {},
    };
    const fetcher = vi.fn<typeof fetch>();
    const controller = new OwnerEditorOperation(session, () => storage, fetcher);
    controller.initialize();
    await controller.apply(request, grant, subjectId);
    expect(controller.getSnapshot().phase).toBe('blocked');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not adopt or retry a conflicted save until the owner reviews a fresh revision', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const request = createRequest();
    if (!request) throw Error('Expected valid note request');
    const conflict: OwnerEditorReply = {
      version: 1,
      authority: 'operation_receipt',
      command: 'create_owner_memory',
      operationId,
      requestHash: ownerEditorRequestHash(request),
      statusVersion: 2,
      outcome: 'conflict',
      reason: 'revision_changed',
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(conflict));
    const storage = new MemoryStorage();
    const controller = new OwnerEditorOperation(session, () => storage, fetcher);
    controller.initialize();
    await controller.apply(request, grant, subjectId);
    expect(controller.getSnapshot(), controller.getSnapshot().message).toMatchObject({
      phase: 'resolved',
      reviewRequired: true,
    });
    const nextGrant = {
      ...grant,
      operationId: nextOperationId,
      issuedOperationHandle: 'next-handle',
    };
    expect(
      hasFreshPersonNoteGrant({
        state: controller.getSnapshot(),
        previousOperationId: operationId,
        session,
        snapshot: { ...snapshot, revision: 'c'.repeat(64) },
        grant: nextGrant,
      }),
    ).toBe(true);
    expect(controller.reviewFreshSnapshot([nextGrant])).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', reviewRequired: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('renders the unavailable state when the parent has no fresh snapshot or grant', () => {
    const html = renderToStaticMarkup(
      <PersonNoteCreator session={session} snapshot={null} grant={null} />,
    );
    expect(html).toContain('Adding a note is unavailable for this person view.');
    expect(html).not.toContain('Add a note</button>');
  });

  it('does not call a saved receipt success when its memory ID is the person ID', () => {
    const state = operationState({ reply: receipt({ ids: { memoryId: subjectId } }) });
    const html = renderToStaticMarkup(
      <PersonNoteResultStatus state={state} displayed={null} noteHref={null} />,
    );
    expect(personNoteCreatedMemoryId(state, null)).toBeNull();
    expect(html).toContain('note identity could not be verified');
    expect(html).not.toContain('Saved.');
    expect(html).not.toContain('Review saved note');
  });

  it('labels global duplicate conflicts without adopting or linking the existing note', () => {
    for (const reason of ['memory_duplicate', 'memory_content_duplicate']) {
      const state = operationState({
        reply: receipt({ outcome: 'conflict', reason } as Partial<
          Extract<OwnerEditorReply, { authority: 'operation_receipt' }>
        >),
        reviewRequired: true,
      });
      expect(personNoteCreateConflictMessage(state)).toBe(
        'A note with this text already exists. This attempt did not add another note.',
      );
      expect(personNoteCreatedMemoryId(state, null)).toBeNull();
    }
  });

  it('shows Check result with no saved draft when a reload restores a pending create marker', () => {
    const state = operationState({
      phase: 'pending',
      reply: null,
      marker: { id: grant.issuedOperationHandle, command: grant.command, targetId: subjectId },
      message: 'Save could not be confirmed. Check its result before saving again.',
    });
    const html = renderToStaticMarkup(<PersonNoteRecovery state={state} checkResult={() => {}} />);
    expect(html).toContain('Check result');
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('Add saved note');
    expect(html).toContain('Reloading loses the note text.');
    expect(html).not.toContain(content);
  });
});

import { parseOwnerEditorRequest } from '@assistant/application/owner-editor-wire';
import type { OwnerEditorFormGrant, OwnerEditorReply } from '@assistant/persistence/owner-editor';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ownerEditorRequestHash } from '../../../packages/application/src/owner-editor-hash';
import { type OwnerEditorStorage, readOwnerEditorPendingMarker } from './owner-editor-client';
import { OwnerEditorOperation, ownerEditorOutcomeMessage } from './owner-editor-operation';
import {
  OwnerEditorDialogStatus,
  type OwnerEditorDisplayScope,
  ownerEditorDialogMessage,
} from './owner-editor-status';

const owner = '10000000-0000-4000-8000-000000000001';
const contact = '20000000-0000-4000-8000-000000000001';
const other = '20000000-0000-4000-8000-000000000002';
const relation = '30000000-0000-4000-8000-000000000001';
const replacementRelation = '30000000-0000-4000-8000-000000000002';
const oldOp = '40000000-0000-4000-8000-000000000001';
const newOp = '40000000-0000-4000-8000-000000000002';
const revision = 'a'.repeat(64);
const session = { ownerId: owner, formSessionScope: 'invented-status-session' };
class Storage implements OwnerEditorStorage {
  values = new Map<string, string>();
  failRead = false;
  getItem(key: string) {
    if (this.failRead) throw new Error('Storage unavailable');
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
  const storage = new Storage();
  const request = vi.fn<typeof fetch>();
  const controller = new OwnerEditorOperation(session, () => storage, request);
  controller.initialize();
  return { storage, request, controller };
}
function grant(
  command: OwnerEditorFormGrant['command'],
  operationId = oldOp,
): OwnerEditorFormGrant {
  return { command, operationId, issuedOperationHandle: `invented-handle:${operationId}` };
}
const correction = grant('correct_owner_family_relationship');
const nextCorrection = grant('correct_owner_family_relationship', newOp);
const scope = (g: OwnerEditorFormGrant, targetId: string | null): OwnerEditorDisplayScope => ({
  command: g.command,
  operationId: g.operationId,
  targetId,
});
function body(g: OwnerEditorFormGrant) {
  const envelope = { version: 1, intent: 'apply', command: g.command, operationId: g.operationId };
  return {
    ...envelope,
    targetRelationId: relation,
    expectedTargetRevision: revision,
    replacement: {
      subjectContactId: contact,
      objectContactId: other,
      expectedSubjectRevision: revision,
      expectedObjectRevision: revision,
      predicate: 'parent_of',
      timing: 'unspecified',
      validity: { validFrom: null, validUntil: null },
      note: '',
      expectedCanonicalState: { kind: 'absent' },
    },
  };
}
function hash(request: unknown) {
  const parsed = parseOwnerEditorRequest(request, '/api/profile/knowledge/family');
  if (!parsed.ok || parsed.request.intent !== 'apply') throw new Error('Invalid status fixture');
  return ownerEditorRequestHash(parsed.request);
}
function saved(g: OwnerEditorFormGrant): OwnerEditorReply {
  return {
    version: 1,
    authority: 'operation_receipt',
    command: g.command,
    operationId: g.operationId,
    requestHash: hash(body(g)),
    statusVersion: 2,
    outcome: 'saved',
    ids: { relationId: replacementRelation, memoryId: contact, assertionId: other },
    revision,
  };
}
async function complete(g = correction) {
  const f = fixture();
  f.request.mockResolvedValueOnce(Response.json(saved(g)));
  await f.controller.apply(body(g), g, relation);
  expect(f.controller.getSnapshot().phase).toBe('resolved');
  return f;
}
const render = (controller: OwnerEditorOperation, displayed: OwnerEditorDisplayScope | null) =>
  renderToStaticMarkup(
    <OwnerEditorDialogStatus state={controller.getSnapshot()} displayed={displayed} />,
  );

describe('dialog completion status stays bound to the captured operation and target', () => {
  it('correction Saved → fresh correction hides only the old status without clearing its receipt', async () => {
    const f = await complete();
    expect(render(f.controller, scope(correction, relation))).toContain('Saved.');
    expect(f.controller.acceptFreshSnapshot([nextCorrection])).toBe(true);
    const snapshot = f.controller.getSnapshot();
    const persisted = [...f.storage.values];
    expect(snapshot.message).toBe('Saved.');
    expect(render(f.controller, scope(nextCorrection, replacementRelation))).toBe('');
    expect(f.controller.getSnapshot()).toBe(snapshot);
    expect([...f.storage.values]).toEqual(persisted);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('keeps the current terminal status after fresh readback grants arrive', async () => {
    const own = grant('correct_owner_family_relationship');
    const f = await complete(own);
    const captured = scope(own, relation);
    expect(render(f.controller, captured)).toContain('Saved.');
    expect(f.controller.acceptFreshSnapshot([nextCorrection])).toBe(true);
    // The open form's tuple stays captured; fresh server props do not replace it.
    expect(render(f.controller, captured)).toContain('Saved.');
    expect(render(f.controller, scope(nextCorrection, relation))).toBe('');
  });
  it.each(['operationId', 'command', 'targetId'] as const)(
    'requires matching %s independently',
    async (field) => {
      const f = await complete();
      const displayed = {
        ...scope(correction, relation),
        [field]:
          field === 'operationId'
            ? newOp
            : field === 'command'
              ? 'add_family_relationship'
              : replacementRelation,
      } as OwnerEditorDisplayScope;
      expect(render(f.controller, displayed)).toBe('');
      expect(render(f.controller, scope(correction, relation))).toContain('Saved.');
    },
  );
  it('keeps a new storage-blocked warning even though an old successful receipt remains', async () => {
    const f = await complete();
    f.storage.failRead = true;
    expect(f.controller.acceptFreshSnapshot([nextCorrection])).toBe(false);
    expect(f.controller.getSnapshot().phase).toBe('blocked');
    expect(f.controller.getSnapshot().reply?.authority).toBe('operation_receipt');
    expect(render(f.controller, scope(nextCorrection, replacementRelation))).toContain(
      'cannot safely track saves',
    );
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('keeps current validation errors for the new form without dispatch or marker loss', async () => {
    const f = await complete();
    expect(f.controller.acceptFreshSnapshot([nextCorrection])).toBe(true);
    await f.controller.apply(
      { ...body(nextCorrection), expectedTargetRevision: '' },
      nextCorrection,
      relation,
    );
    expect(Object.keys(f.controller.getSnapshot().fieldErrors).length).toBeGreaterThan(0);
    expect(render(f.controller, scope(nextCorrection, relation))).toContain(
      'Check the highlighted fields.',
    );
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(readOwnerEditorPendingMarker(f.storage, owner, session.formSessionScope)).toBeNull();
  });
  it('preserves an unknown original across close/reopen presentation and reload/check authority', async () => {
    const own = grant('correct_owner_family_relationship');
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error('Response lost'));
    await f.controller.apply(body(own), own, relation);
    const originalMarker = readOwnerEditorPendingMarker(f.storage, owner, session.formSessionScope);
    const snapshot = f.controller.getSnapshot();
    expect(render(f.controller, scope(own, relation))).toContain('could not be confirmed');
    expect(render(f.controller, scope(nextCorrection, replacementRelation))).toContain(
      'could not be confirmed',
    );
    expect(f.controller.getSnapshot()).toBe(snapshot);
    expect(readOwnerEditorPendingMarker(f.storage, owner, session.formSessionScope)).toEqual(
      originalMarker,
    );
    const reloaded = new OwnerEditorOperation(session, () => f.storage, f.request);
    reloaded.initialize();
    expect(render(reloaded, scope(nextCorrection, replacementRelation))).toContain(
      'earlier save could not be confirmed',
    );
    f.request.mockResolvedValueOnce(
      Response.json(
        {
          version: 1,
          authority: 'unresolved',
          command: own.command,
          operationId: own.operationId,
          outcome: 'outcome_unknown',
          reason: 'preparing',
          receiptBindingToken: 'original-authenticated-proof',
        },
        { status: 202 },
      ),
    );
    await reloaded.checkPendingResult();
    expect(reloaded.canReconcile()).toBe(true);
    expect(f.request.mock.calls[1]?.[0]).toBe(
      `/api/profile/knowledge/family?operation=${encodeURIComponent(own.issuedOperationHandle)}`,
    );
    expect(f.request.mock.calls[1]?.[1]?.method).toBe('GET');
    expect(readOwnerEditorPendingMarker(f.storage, owner, session.formSessionScope)).toEqual(
      originalMarker,
    );
    expect(render(reloaded, scope(nextCorrection, replacementRelation))).toContain(
      'could not be confirmed',
    );
  });
  it('keeps stale conflict and requires explicit fresh review instead of clearing it on a new form', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(
      Response.json(
        {
          version: 1,
          authority: 'operation_receipt',
          command: correction.command,
          operationId: correction.operationId,
          requestHash: hash(body(correction)),
          statusVersion: 2,
          outcome: 'conflict',
          reason: 'relation_changed',
        },
        { status: 409 },
      ),
    );
    await f.controller.apply(body(correction), correction, relation);
    const fresh = grant(correction.command, newOp);
    expect(f.controller.acceptFreshSnapshot([fresh])).toBe(false);
    expect(render(f.controller, scope(fresh, relation))).toContain(
      'Review the latest saved values',
    );
    expect(f.controller.getSnapshot().reviewRequired).toBe(true);
    expect(f.controller.reviewFreshSnapshot([fresh])).toBe(true);
    expect(render(f.controller, scope(fresh, relation))).toContain(
      'Review the latest saved values',
    );
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('filters only exact formatter success, never arbitrary status text or current error state', async () => {
    const f = await complete();
    const state = f.controller.getSnapshot();
    expect(state.reply).not.toBeNull();
    if (!state.reply) throw new Error('Missing receipt');
    expect(state.message).toBe(ownerEditorOutcomeMessage(state.reply));
    expect(
      ownerEditorDialogMessage(
        { ...state, message: 'Saved. A new error needs attention.' },
        scope(nextCorrection, relation),
      ),
    ).toBe('Saved. A new error needs attention.');
    const withError = { ...state, fieldErrors: { request: 'A current error' } };
    expect(ownerEditorDialogMessage(withError, scope(nextCorrection, relation))).toBe('');
    // The obsolete success is not the separately rendered current field error.
    expect(withError.fieldErrors).toEqual({ request: 'A current error' });
    expect(ownerEditorDialogMessage(state, null)).toBe('');
  });
});

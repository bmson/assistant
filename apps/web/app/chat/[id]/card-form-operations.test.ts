import { CardFormSchema } from '@assistant/persistence/card-form';
import { describe, expect, it } from 'vitest';
import {
  beginCardFormOperation,
  blockCardFormDraftForTask,
  type CardFormOperationStorage,
  cardFormCallbackGeneration,
  cardFormDraftKey,
  carryCardFormDraft,
  clearCardFormSessionStorage,
  formatCardFormMessage,
  markCardFormReviewed,
  parseActiveCardFormConflict,
  parseStaleCardFormConflict,
  readCardFormDraft,
  recordCardFormTask,
  releaseBlockedCardFormDraft,
  releaseStaleCardFormOperation,
  sessionScopedCardFormStorage,
  settleCardFormTask,
  updateCardFormValues,
} from './card-form-operations';

class MemoryStorage implements CardFormOperationStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
}

const identity = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  cardId: '22222222-2222-4222-8222-222222222222',
  revisionId: '33333333-3333-4333-8333-333333333333',
  formId: 'event',
};
const taskId = '44444444-4444-4444-8444-444444444444';
const form = CardFormSchema.parse({
  type: 'form',
  id: 'event',
  title: 'Event details',
  serverAction: 'submit_owner_chat_turn',
  submitLabel: 'Review',
  warningFactIds: [],
  fields: [
    { id: 'date', type: 'date', label: 'Date', required: true },
    { id: 'guest', type: 'text', label: 'Guest', required: false },
    { id: 'confirmed', type: 'boolean', label: 'Confirmed', required: true },
  ],
});

describe('card form composer operation', () => {
  it('recognizes only the explicit active-form conflict response', () => {
    expect(
      parseActiveCardFormConflict({
        ok: false,
        status: 409,
        reason: 'active_form',
        activeTaskId: taskId,
        taskStatus: 'waiting_approval',
        error: 'A form task is already active.',
      }),
    ).toEqual({ taskId, taskStatus: 'waiting_approval', error: 'A form task is already active.' });
    expect(
      parseActiveCardFormConflict({
        ok: false,
        status: 409,
        reason: 'revision_conflict',
        activeTaskId: taskId,
        taskStatus: 'waiting_approval',
        error: 'The card changed.',
      }),
    ).toBeNull();
    expect(
      parseActiveCardFormConflict({
        ok: false,
        status: 409,
        reason: 'active_form',
        activeTaskId: 'not-a-task',
        taskStatus: 'waiting_approval',
        error: 'A form task is already active.',
      }),
    ).toBeNull();
  });

  it('keeps editable answers and freezes the exact reviewed message under one operation ID', () => {
    const storage = new MemoryStorage();
    const values = { date: '2026-10-09', guest: 'Riley', confirmed: false };
    const draft = updateCardFormValues({ storage, current: null, identity, values });
    const reviewed = { ...draft, reviewed: true };
    storage.setItem(cardFormDraftKey(identity.conversationId), JSON.stringify(reviewed));
    const ownerMessageText = 'Please plan the event for Friday with Riley.';
    const frozen = beginCardFormOperation({
      storage,
      draft: reviewed,
      form,
      ownerMessageText,
      createId: () => '55555555-5555-4555-8555-555555555555',
    });
    expect(frozen.operation?.submission).toMatchObject({
      conversationId: identity.conversationId,
      cardId: identity.cardId,
      expectedRevisionId: identity.revisionId,
      formId: 'event',
      operationId: '55555555-5555-4555-8555-555555555555',
      values,
      ownerMessageText,
    });
    const restored = readCardFormDraft(storage, identity.conversationId);
    expect(restored).toEqual(frozen);
    expect(
      beginCardFormOperation({
        storage,
        draft: restored!,
        form,
        ownerMessageText,
        createId: () => '66666666-6666-4666-8666-666666666666',
      }),
    ).toEqual(frozen);
    expect(() =>
      beginCardFormOperation({
        storage,
        draft: restored!,
        form,
        ownerMessageText: 'Changed after send',
        createId: () => '77777777-7777-4777-8777-777777777777',
      }),
    ).toThrow(/already in progress/);
    expect(formatCardFormMessage(form, values)).toContain('Confirmed: No');
  });

  it('does not release a parked or mismatched task and releases only the exact terminal receipt', () => {
    const storage = new MemoryStorage();
    const draft = beginCardFormOperation({
      storage,
      draft: updateCardFormValues({
        storage,
        current: null,
        identity,
        values: { date: '2026-10-09', confirmed: true },
      }),
      form,
      ownerMessageText: 'Please plan the event.',
      createId: () => '55555555-5555-4555-8555-555555555555',
    });
    const accepted = recordCardFormTask({
      storage,
      draft,
      operationId: '55555555-5555-4555-8555-555555555555',
      taskId,
      cursor: 'opaque-message-cursor',
    });
    expect(
      settleCardFormTask({
        storage,
        draft: accepted,
        taskId: '99999999-9999-4999-8999-999999999999',
        status: 'done',
      }),
    ).toEqual(accepted);
    expect(
      settleCardFormTask({ storage, draft: accepted, taskId, status: 'waiting_approval' }),
    ).toEqual(accepted);
    expect(settleCardFormTask({ storage, draft: accepted, taskId, status: 'done' })).toBeNull();
    expect(readCardFormDraft(storage, identity.conversationId)).toBeNull();
    const settled = settleCardFormTask({ storage, draft: accepted, taskId, status: 'failed' });
    expect(settled?.operation).toBeUndefined();
    expect(settled?.values).toEqual(accepted.values);
    expect(settled?.reviewed).toBe(false);
    expect(settled?.composerText).toBe(accepted.operation?.submission.ownerMessageText);
    expect(readCardFormDraft(storage, identity.conversationId)).toEqual(settled);
  });

  it('keeps an active-task conflict as an unsent draft and releases it only after that exact task terminates', () => {
    const storage = new MemoryStorage();
    const operationId = '55555555-5555-4555-8555-555555555555';
    const activeTaskId = '66666666-6666-4666-8666-666666666666';
    const values = { date: '2026-10-09', guest: 'Riley', confirmed: true };
    const reviewed = {
      ...updateCardFormValues({ storage, current: null, identity, values }),
      reviewed: true,
    };
    const operation = beginCardFormOperation({
      storage,
      draft: reviewed,
      form,
      ownerMessageText: 'Please invite Riley.',
      createId: () => operationId,
    });
    const blocked = blockCardFormDraftForTask({
      storage,
      draft: operation,
      operationId,
      taskId: activeTaskId,
      taskStatus: 'waiting_approval',
    });
    expect(blocked.operation).toBeUndefined();
    expect(blocked.blockedByTask).toEqual({
      taskId: activeTaskId,
      taskStatus: 'waiting_approval',
      submission: operation.operation?.submission,
    });
    expect(readCardFormDraft(storage, identity.conversationId)).toEqual(blocked);
    expect(() =>
      beginCardFormOperation({
        storage,
        draft: blocked,
        form,
        ownerMessageText: 'Please invite Riley.',
        createId: () => '77777777-7777-4777-8777-777777777777',
      }),
    ).toThrow(/another request.*still running/i);
    expect(
      releaseBlockedCardFormDraft({
        storage,
        draft: blocked,
        taskId: '88888888-8888-4888-8888-888888888888',
        status: 'done',
      }),
    ).toEqual(blocked);
    expect(
      releaseBlockedCardFormDraft({
        storage,
        draft: blocked,
        taskId: activeTaskId,
        status: 'waiting_approval',
      }),
    ).toEqual(blocked);

    const released = releaseBlockedCardFormDraft({
      storage,
      draft: blocked,
      taskId: activeTaskId,
      status: 'failed',
    });
    expect(released.blockedByTask).toBeUndefined();
    expect(released.values).toEqual(values);
    expect(released.reviewed).toBe(true);
    expect(released.releasedBlockedTask).toBe(true);
    expect(readCardFormDraft(storage, identity.conversationId)?.releasedBlockedTask).toBe(true);
    expect(readCardFormDraft(storage, identity.conversationId)).toEqual(released);
    const explicitlyReviewed = markCardFormReviewed(storage, released, 'Please invite Riley.');
    expect(explicitlyReviewed.releasedBlockedTask).toBeUndefined();

    const resent = beginCardFormOperation({
      storage,
      draft: explicitlyReviewed,
      form,
      ownerMessageText: 'Please invite Riley.',
      createId: () => '99999999-9999-4999-8999-999999999999',
    });
    expect(resent.operation?.submission.operationId).toBe('99999999-9999-4999-8999-999999999999');
    expect(resent.releasedBlockedTask).toBeUndefined();
    expect(resent.operation?.submission.values).toEqual(values);
  });

  it('partitions drafts by authenticated session and preserves explicit false review state', () => {
    const backing = new MemoryStorage();
    const first = sessionScopedCardFormStorage(backing, 'session-scope-000001');
    const second = sessionScopedCardFormStorage(backing, 'session-scope-000002');
    const draft = updateCardFormValues({
      storage: first,
      current: null,
      identity,
      values: { date: '2026-10-09', confirmed: false },
    });
    expect(readCardFormDraft(first, identity.conversationId)).toEqual(draft);
    expect(readCardFormDraft(second, identity.conversationId)).toBeNull();
    expect(
      [...backing.values.keys()].some((key) =>
        key.includes(encodeURIComponent('session-scope-000001')),
      ),
    ).toBe(true);
    expect(() => sessionScopedCardFormStorage(backing, 'short')).toThrow(/session is unavailable/);
    clearCardFormSessionStorage(backing, 'session-scope-000001');
    expect(readCardFormDraft(first, identity.conversationId)).toBeNull();
    expect(readCardFormDraft(second, identity.conversationId)).toBeNull();
    expect(backing.getItem('assistant:card-form-active-scope:v1')).toBe('session-scope-000002');
  });

  it('clears the last verified session partition on the next authenticated scope transition', () => {
    const backing = new MemoryStorage();
    const first = sessionScopedCardFormStorage(backing, 'session-scope-000001');
    const draft = updateCardFormValues({
      storage: first,
      current: null,
      identity,
      values: { date: '2026-10-09', confirmed: false },
    });
    expect(readCardFormDraft(first, identity.conversationId)).toEqual(draft);
    const second = sessionScopedCardFormStorage(backing, 'session-scope-000002');
    expect(readCardFormDraft(first, identity.conversationId)).toBeNull();
    expect(readCardFormDraft(second, identity.conversationId)).toBeNull();
    expect(backing.getItem('assistant:card-form-active-scope:v1')).toBe('session-scope-000002');
  });

  it('invalidates in-flight form callbacks before clearing a verified session namespace', () => {
    const backing = new MemoryStorage();
    const scoped = sessionScopedCardFormStorage(backing, 'session-scope-000001');
    scoped.setItem(cardFormDraftKey(identity.conversationId), JSON.stringify({ retained: true }));
    const before = cardFormCallbackGeneration();
    clearCardFormSessionStorage(backing, 'session-scope-000001');
    expect(cardFormCallbackGeneration()).toBe(before + 1);
    expect(backing.length).toBe(0);
  });

  it('round-trips an explicitly unreviewed draft as false within its session partition', () => {
    const backing = new MemoryStorage();
    const scoped = sessionScopedCardFormStorage(backing, 'session-scope-000001');
    const draft = updateCardFormValues({
      storage: scoped,
      current: null,
      identity,
      values: { date: '2026-10-09', confirmed: false },
    });
    const stored = backing.getItem(
      `${'assistant:card-form-session:v1:session-scope-000001:'}${cardFormDraftKey(identity.conversationId)}`,
    );
    expect(stored).toContain('"reviewed":false');
    expect(readCardFormDraft(scoped, identity.conversationId)).toEqual(draft);
  });

  it('recognizes only a typed stale-revision rejection and releases that exact operation for fresh review', () => {
    const storage = new MemoryStorage();
    const operationId = '55555555-5555-4555-8555-555555555555';
    const draft = beginCardFormOperation({
      storage,
      draft: {
        ...updateCardFormValues({
          storage,
          current: null,
          identity,
          values: { date: '2026-10-09', confirmed: false },
        }),
        reviewed: true,
      },
      form,
      ownerMessageText: 'Please plan this event.',
      createId: () => operationId,
    });
    expect(
      parseStaleCardFormConflict({
        ok: false,
        status: 409,
        reason: 'stale_revision',
        error: 'A newer card exists.',
      }),
    ).toEqual({ error: 'A newer card exists.' });
    expect(
      parseStaleCardFormConflict({
        ok: false,
        status: 409,
        reason: 'active_form',
        error: 'Still running.',
      }),
    ).toBeNull();
    const released = releaseStaleCardFormOperation({ storage, draft, operationId });
    expect(released.operation).toBeUndefined();
    expect(released.reviewed).toBe(false);
    expect(released.composerText).toBe('Please plan this event.');
    expect(released.values.confirmed).toBe(false);
    expect(readCardFormDraft(storage, identity.conversationId)).toEqual(released);
  });

  it('rejects oversized raw drafts before attempting JSON parsing', () => {
    const storage = new MemoryStorage();
    storage.setItem(cardFormDraftKey(identity.conversationId), '{'.repeat(16_385));
    expect(() => readCardFormDraft(storage, identity.conversationId)).toThrow(/unavailable/);
  });

  it('carries only compatible answers to a newer revision after an explicit action', () => {
    const storage = new MemoryStorage();
    const previous = updateCardFormValues({
      storage,
      current: null,
      identity,
      values: { date: '2026-10-09', guest: 'Riley', confirmed: false },
    });
    const nextIdentity = { ...identity, revisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    const nextForm = CardFormSchema.parse({
      ...form,
      fields: [
        { id: 'date', type: 'date', label: 'Date', required: true },
        { id: 'venue', type: 'text', label: 'Venue', required: true },
      ],
    });
    const carried = carryCardFormDraft({
      storage,
      draft: previous,
      identity: nextIdentity,
      form: nextForm,
    });
    expect(carried.identity).toEqual(nextIdentity);
    expect(carried.values).toEqual({ date: '2026-10-09' });
    expect(carried.reviewed).toBe(false);
    expect(readCardFormDraft(storage, identity.conversationId)).toEqual(carried);
  });

  it('drops a changed type or removed choice while keeping independent compatible answers', () => {
    const storage = new MemoryStorage();
    const previous = updateCardFormValues({
      storage,
      current: null,
      identity,
      values: { date: '2026-10-09', guest: 'Riley', confirmed: false },
    });
    const nextIdentity = { ...identity, revisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    const nextForm = CardFormSchema.parse({
      ...form,
      fields: [
        { id: 'date', type: 'date', label: 'Date', required: true },
        {
          id: 'guest',
          type: 'choice',
          label: 'Guest',
          required: true,
          options: [
            { id: 'alex', label: 'Alex' },
            { id: 'sam', label: 'Sam' },
          ],
        },
        { id: 'confirmed', type: 'text', label: 'Confirmation note', required: true },
      ],
    });
    const carried = carryCardFormDraft({
      storage,
      draft: previous,
      identity: nextIdentity,
      form: nextForm,
    });
    expect(carried.values).toEqual({ date: '2026-10-09' });
    expect(carried.reviewed).toBe(false);
    expect(readCardFormDraft(storage, identity.conversationId)).toEqual(carried);
  });
});

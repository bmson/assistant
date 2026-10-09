import { describe, expect, it, vi } from 'vitest';
import {
  type CardRefreshOperationStorage,
  cardRefreshOperationId,
  recordCardRefreshTask,
  submitCardRefresh,
} from './card-refresh-operations.js';

const cardId = '11111111-2222-4333-8444-555555555555';
const revisionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const taskId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const operationIds = [
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
];

function memoryStorage(): CardRefreshOperationStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe('saved-card refresh operation identity', () => {
  it('submits the viewed card revision and reuses its operation ID after a lost response', async () => {
    const storage = memoryStorage();
    let created = 0;
    const createId = () => operationIds[created++] ?? '';
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('response was lost'))
      .mockResolvedValueOnce({ ok: true, taskId });
    const input = {
      cardId,
      revisionId,
      state: {},
      storage,
      createId,
      send,
    };

    await expect(submitCardRefresh(input)).rejects.toThrow('response was lost');
    await expect(submitCardRefresh(input)).resolves.toEqual({ ok: true, taskId });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]).toEqual([cardId, revisionId, operationIds[0]]);
    expect(send.mock.calls[1]).toEqual([cardId, revisionId, operationIds[0]]);
    expect(created).toBe(1);
  });

  it.each([
    ['invalid JSON', '{'],
    ['invalid operation ID', '{"operationId":"not-a-uuid"}'],
    ['unknown receipt fields', `{"operationId":"${operationIds[0]}","extra":true}`],
    ['invalid saved task ID', `{"operationId":"${operationIds[0]}","taskId":"bad"}`],
  ])('fails closed on a corrupt saved receipt (%s)', async (_label, receipt) => {
    const values = new Map<string, string>([
      [`assistant:card-refresh:v1:${cardId}:${revisionId}`, receipt],
    ]);
    const storage: CardRefreshOperationStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    };
    const createId = vi.fn(() => operationIds[0] ?? '');
    const send = vi.fn(async () => ({ ok: true, taskId }));

    await expect(
      submitCardRefresh({ cardId, revisionId, state: {}, storage, createId, send }),
    ).rejects.toThrow('Saved-card refresh receipt is malformed');
    expect(createId).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not claim success without a task receipt', async () => {
    await expect(
      submitCardRefresh({
        cardId,
        revisionId,
        state: {},
        storage: memoryStorage(),
        createId: () => operationIds[0] ?? '',
        send: async () => ({ ok: true }),
      }),
    ).rejects.toThrow('Refresh task receipt is missing');
  });

  it('reuses an operation ID for a lost response and the same card revision', () => {
    const storage = memoryStorage();
    let created = 0;
    const createId = () => operationIds[created++] ?? operationIds.at(-1) ?? '';
    const first = cardRefreshOperationId(cardId, revisionId, storage, createId);
    const retryAfterLostResponse = cardRefreshOperationId(cardId, revisionId, storage, createId);

    expect(first).toBe(operationIds[0]);
    expect(retryAfterLostResponse).toBe(first);
    expect(created).toBe(1);
    expect(
      cardRefreshOperationId(cardId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', storage, createId),
    ).toBe(operationIds[1]);
  });

  it('rotates only after the server confirms the prior task reached a terminal state', () => {
    const storage = memoryStorage();
    let created = 0;
    const createId = () => operationIds[created++] ?? '';
    const first = cardRefreshOperationId(cardId, revisionId, storage, createId);
    recordCardRefreshTask(cardId, revisionId, first, taskId, storage);

    expect(
      cardRefreshOperationId(cardId, revisionId, storage, createId, {
        refreshState: 'refreshing',
        refreshTaskId: taskId,
      }),
    ).toBe(first);
    expect(
      cardRefreshOperationId(cardId, revisionId, storage, createId, {
        refreshState: 'failed',
        refreshTaskId: taskId,
      }),
    ).toBe(operationIds[1]);
  });

  it('does not rotate an unknown operation based on another task terminal state', () => {
    const storage = memoryStorage();
    let created = 0;
    const createId = () => operationIds[created++] ?? '';
    const first = cardRefreshOperationId(cardId, revisionId, storage, createId);

    expect(
      cardRefreshOperationId(cardId, revisionId, storage, createId, {
        refreshState: 'failed',
        refreshTaskId: taskId,
      }),
    ).toBe(first);
    expect(created).toBe(1);
  });

  it('does not overwrite a newer operation with a late task receipt', () => {
    const storage = memoryStorage();
    let created = 0;
    const createId = () => operationIds[created++] ?? '';
    const first = cardRefreshOperationId(cardId, revisionId, storage, createId);
    recordCardRefreshTask(cardId, revisionId, first, taskId, storage);
    const second = cardRefreshOperationId(cardId, revisionId, storage, createId, {
      refreshState: 'failed',
      refreshTaskId: taskId,
    });
    recordCardRefreshTask(cardId, revisionId, first, taskId, storage);

    expect(second).toBe(operationIds[1]);
    expect(cardRefreshOperationId(cardId, revisionId, storage, createId)).toBe(second);
  });
});

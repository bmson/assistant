import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ChecklistCancellationRequest,
  cancelActivityChecklistItem,
  reconcileActivityChecklistCancellation,
} from './checklist-cancellation-client.js';

const request: ChecklistCancellationRequest = {
  taskId: 'task-1',
  itemId: 'reminder-2',
  expectedRevision: 3,
  expectedCancellationRevision: 1,
  ownerMessageId: '00000000-0000-4000-8000-000000000004',
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function successBody(outcome: 'cancelled' | 'already_cancelled' = 'cancelled') {
  return {
    ok: true,
    outcome,
    transitioned: outcome === 'cancelled',
    queueGeneration: 8,
    ownerMessageId: request.ownerMessageId,
    taskId: request.taskId,
    itemId: request.itemId,
    checklistRevision: request.expectedRevision,
    cancellationRevision: request.expectedCancellationRevision + 1,
  };
}

function auditReadback(overrides: Record<string, unknown> = {}) {
  return {
    id: request.taskId,
    checklistRevision: request.expectedRevision,
    cancellationRevision: request.expectedCancellationRevision + 1,
    audit: {
      revision: request.expectedCancellationRevision + 1,
      checklistRevision: request.expectedRevision,
      taskId: request.taskId,
      conversationId: 'conversation-1',
      ownerTaskId: request.taskId,
      ownerMessageId: request.ownerMessageId,
      itemIds: [request.itemId],
      requestSpans: ['Remind me about the hotel'],
    },
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe('selected checklist item cancellation client', () => {
  it('posts both revisions and accepts only the exact item operation receipt', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(successBody()));
    await expect(cancelActivityChecklistItem(request, fetcher)).resolves.toEqual({
      kind: 'cancelled',
      ownerMessageId: request.ownerMessageId,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/mobile/v1/activity/task-1');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      action: 'cancel-checklist',
      itemId: request.itemId,
      expectedRevision: request.expectedRevision,
      expectedCancellationRevision: request.expectedCancellationRevision,
      ownerMessageId: request.ownerMessageId,
    });
  });

  it('accepts an exact replay receipt without claiming a second transition', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(successBody('already_cancelled')));
    await expect(cancelActivityChecklistItem(request, fetcher)).resolves.toEqual({
      kind: 'cancelled',
      ownerMessageId: request.ownerMessageId,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reconciles an ambiguous POST only through its exact persisted item audit', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      if (String(input).includes('cancellationOwnerMessageId='))
        return Promise.resolve(jsonResponse(auditReadback()));
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    });
    const saving = cancelActivityChecklistItem(request, fetcher);
    await vi.advanceTimersByTimeAsync(9_000);
    await expect(saving).resolves.toEqual({
      kind: 'cancelled',
      ownerMessageId: request.ownerMessageId,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe('GET');
    expect(String(fetcher.mock.calls[1]?.[0])).toContain(
      `cancellationOwnerMessageId=${request.ownerMessageId}`,
    );
  });

  it('does not accept a different item, checklist revision, or owner audit as confirmation', async () => {
    const wrongItem = auditReadback({
      audit: { ...auditReadback().audit, itemIds: ['hotel-lookup'] },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(wrongItem));
    await expect(reconcileActivityChecklistCancellation(request, fetcher)).resolves.toBe(false);
    const wrongRevision = auditReadback({
      audit: { ...auditReadback().audit, checklistRevision: request.expectedRevision - 1 },
    });
    await expect(
      reconcileActivityChecklistCancellation(
        request,
        vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(wrongRevision)),
      ),
    ).resolves.toBe(false);
    const wrongOwner = auditReadback({
      audit: { ...auditReadback().audit, ownerMessageId: '00000000-0000-4000-8000-000000000099' },
    });
    await expect(
      reconcileActivityChecklistCancellation(
        request,
        vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(wrongOwner)),
      ),
    ).resolves.toBe(false);
  });

  it('reconciles the original exact operation after a later checklist change, not a later cancellation', async () => {
    const laterChecklist = auditReadback({
      checklistRevision: request.expectedRevision + 1,
      cancellationRevision: request.expectedCancellationRevision + 1,
    });
    await expect(
      reconcileActivityChecklistCancellation(
        request,
        vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(laterChecklist)),
      ),
    ).resolves.toBe(true);

    const laterCancellation = auditReadback({
      cancellationRevision: request.expectedCancellationRevision + 2,
      audit: {
        ...auditReadback().audit,
        revision: request.expectedCancellationRevision + 2,
      },
    });
    await expect(
      reconcileActivityChecklistCancellation(
        request,
        vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(laterCancellation)),
      ),
    ).resolves.toBe(false);
  });

  it('keeps a stale rejection as a rejection and never retries it as a write', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ok: false, outcome: 'stale_revision' }, 409));
    await expect(cancelActivityChecklistItem(request, fetcher)).resolves.toMatchObject({
      kind: 'rejected',
      message: expect.stringContaining('changed'),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('leaves an unconfirmed operation unknown without a second POST', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      if (String(input).includes('cancellationOwnerMessageId='))
        return Promise.resolve(jsonResponse({ ...auditReadback(), audit: null }));
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    });
    const saving = cancelActivityChecklistItem(request, fetcher);
    await vi.advanceTimersByTimeAsync(9_000);
    await expect(saving).resolves.toEqual({ kind: 'unknown' });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

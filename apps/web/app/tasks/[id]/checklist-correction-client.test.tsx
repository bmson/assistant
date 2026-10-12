import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChecklistCorrectionEntry } from './checklist-correction-entry.js';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import {
  type ChecklistCorrectionRequest,
  reconcileActivityChecklistCorrection,
  saveActivityChecklistCorrection,
} from './checklist-correction-client.js';

const request: ChecklistCorrectionRequest = {
  taskId: 'task-1',
  itemId: 'item-2',
  expectedRevision: 3,
  ownerMessageId: '00000000-0000-4000-8000-000000000003',
  replacementLabel: 'Find my flight from Berlin to Paris',
};

function matchingPostback(outcome: 'corrected' | 'already_applied' = 'corrected') {
  return {
    ok: true,
    outcome,
    transitioned: outcome === 'corrected',
    queueGeneration: 4,
    ownerMessageId: request.ownerMessageId,
    taskId: request.taskId,
    itemId: request.itemId,
    revision: request.expectedRevision + 1,
    replacementLabel: request.replacementLabel,
    replacementKind: 'lookup',
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function matchingReadback() {
  return {
    id: request.taskId,
    revision: request.expectedRevision + 1,
    audit: {
      revision: request.expectedRevision + 1,
      ownerMessageId: request.ownerMessageId,
      itemId: request.itemId,
      toLabel: request.replacementLabel,
      toKind: 'lookup',
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('Activity checklist correction client', () => {
  it('shows an explicit one-item picker and does not render completion optimistically', () => {
    const markup = renderToStaticMarkup(
      <ChecklistCorrectionEntry
        taskId="task-1"
        ownerScope="owner-1"
        revision={3}
        items={[
          { id: 'hotel-lookup', label: 'Find my hotel in Berlin' },
          { id: 'flight-lookup', label: 'Find my flight to Paris' },
        ]}
      />,
    );
    expect(markup).toContain('Change a lookup request');
    expect(markup.match(/Change lookup/g)).toHaveLength(2);
    expect(markup).not.toContain('completed');
    expect(markup).not.toContain('Done');
  });

  it('shows cancellation next to the exact pending item without changing its displayed state', () => {
    const markup = renderToStaticMarkup(
      <ChecklistCorrectionEntry
        taskId="task-1"
        ownerScope="owner-1"
        revision={3}
        cancellationRevision={1}
        items={[{ id: 'hotel-lookup', label: 'Find my hotel in Berlin' }]}
        cancellableItems={[
          { id: 'hotel-lookup', label: 'Find my hotel in Berlin' },
          { id: 'hotel-reminder', label: 'Remind me to check in' },
        ]}
      />,
    );
    expect(markup).toContain('Update this request');
    expect(markup).toContain('aria-label="Cancel Find my hotel in Berlin"');
    expect(markup).toContain('aria-label="Cancel Remind me to check in"');
    expect(markup.match(/Cancel item/g)).toHaveLength(2);
    expect(markup).not.toContain('Cancellation confirmed');
    expect(markup).not.toContain('cancelled');
  });

  it('sends one pinned task correction and accepts only its explicit owner-message receipt', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(matchingPostback()));
    await expect(saveActivityChecklistCorrection(request, fetcher)).resolves.toEqual({
      kind: 'saved',
      ownerMessageId: request.ownerMessageId,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/mobile/v1/activity/task-1');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      action: 'correct-checklist',
      itemId: request.itemId,
      expectedRevision: request.expectedRevision,
      ownerMessageId: request.ownerMessageId,
      replacementKind: 'lookup',
      replacementLabel: request.replacementLabel,
    });
  });

  it('reconciles one held POST by exact task, revision, item, kind, and owner-message audit', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      if (String(input).includes('correctionOwnerMessageId='))
        return Promise.resolve(jsonResponse(matchingReadback()));
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    });
    const saving = saveActivityChecklistCorrection(request, fetcher);
    await vi.advanceTimersByTimeAsync(9_000);
    await expect(saving).resolves.toEqual({
      kind: 'saved',
      ownerMessageId: request.ownerMessageId,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain(
      `correctionOwnerMessageId=${request.ownerMessageId}`,
    );
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe('GET');
  });

  it('keeps an ambiguous result unknown and never retries the write automatically', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      if (String(input).includes('correctionOwnerMessageId='))
        return Promise.resolve(jsonResponse({ ...matchingReadback(), audit: null }));
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    });
    const saving = saveActivityChecklistCorrection(request, fetcher);
    await vi.advanceTimersByTimeAsync(9_000);
    await expect(saving).resolves.toEqual({ kind: 'unknown' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('bounds an uncooperative fetcher that ignores abort and reconciles once', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      if (String(input).includes('correctionOwnerMessageId='))
        return Promise.resolve(jsonResponse(matchingReadback()));
      return new Promise(() => {});
    });
    const saving = saveActivityChecklistCorrection(request, fetcher);
    await vi.advanceTimersByTimeAsync(9_000);
    await expect(saving).resolves.toEqual({
      kind: 'saved',
      ownerMessageId: request.ownerMessageId,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('bounds a response body parser that never settles', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      if (String(input).includes('correctionOwnerMessageId='))
        return Promise.resolve(jsonResponse(matchingReadback()));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => new Promise(() => {}),
      } as Response);
    });
    const saving = saveActivityChecklistCorrection(request, fetcher);
    await vi.advanceTimersByTimeAsync(9_000);
    await expect(saving).resolves.toEqual({
      kind: 'saved',
      ownerMessageId: request.ownerMessageId,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('bounds the reconciliation read by the remaining wall deadline', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    });
    const saving = saveActivityChecklistCorrection(request, fetcher);
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(saving).resolves.toEqual({ kind: 'unknown' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(1);
  });

  it('rejects stale writes without reconciliation or a second POST', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ outcome: 'stale_revision' }, 409));
    await expect(saveActivityChecklistCorrection(request, fetcher)).resolves.toMatchObject({
      kind: 'rejected',
      message: expect.stringContaining('changed while the page was open'),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not accept a readback for a different task, revision, or message', async () => {
    const wrongTask = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ...matchingReadback(), id: 'another-task' }));
    const wrongRevision = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ...matchingReadback(),
        audit: { ...matchingReadback().audit, revision: 5 },
      }),
    );
    const wrongMessage = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ...matchingReadback(),
        audit: {
          ...matchingReadback().audit,
          ownerMessageId: '00000000-0000-4000-8000-000000000004',
        },
      }),
    );
    const contradictoryRevision = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ...matchingReadback(), revision: 0 }));
    const oversizedRevision = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ...matchingReadback(), revision: 13 }));
    const arrayAudit = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ ...matchingReadback(), audit: [] }));
    await expect(reconcileActivityChecklistCorrection(request, wrongTask)).resolves.toBe(false);
    await expect(reconcileActivityChecklistCorrection(request, wrongRevision)).resolves.toBe(false);
    await expect(reconcileActivityChecklistCorrection(request, wrongMessage)).resolves.toBe(false);
    await expect(
      reconcileActivityChecklistCorrection(request, contradictoryRevision),
    ).resolves.toBe(false);
    await expect(reconcileActivityChecklistCorrection(request, oversizedRevision)).resolves.toBe(
      false,
    );
    await expect(reconcileActivityChecklistCorrection(request, arrayAudit)).resolves.toBe(false);
  });
});

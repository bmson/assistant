import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { requestChatOperationCancellation } from '../chat-operation-cancellation-client';
import {
  CANCELLED_REQUEST_NOTE,
  cancelledRequestNote,
  readUnconfirmedStop,
  recoveryTaskFromUrl,
  requestRecoveryHref,
  requestStatusNote,
  saveUnconfirmedStop,
  selectedRequestNote,
} from './chat-request-recovery';
import { ChatTurnFeedback } from './chat-turn-feedback';

const conversationId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';

describe('request recovery identity and honest presentation', () => {
  it('links to exactly this owner chat request and offers a path back without task selection', () => {
    const href = requestRecoveryHref(conversationId, taskId) ?? '';
    const html = renderToStaticMarkup(
      <ChatTurnFeedback
        conversationId={conversationId}
        showError={false}
        error={null}
        note={{ text: CANCELLED_REQUEST_NOTE, retryable: false, taskId }}
        pollTrouble={null}
        canRetry
        onRetry={vi.fn()}
      />,
    );
    expect(html).toContain(`href="${href}"`);
    expect(html).toContain(`href="/chat/${conversationId}"`);
    expect(html).toContain('id="request-status"');
    expect(html).toContain('tabindex="-1"');
    expect(html).not.toContain('/tasks');
    expect(html).not.toContain('Try again');
    expect(recoveryTaskFromUrl(`https://assistant.test${href}`, conversationId)).toBe(taskId);
    expect(recoveryTaskFromUrl(`https://assistant.test${href}`, operationId)).toBeNull();
    expect(
      recoveryTaskFromUrl(
        `https://assistant.test/chat/${conversationId}?task=bogus`,
        conversationId,
      ),
    ).toBeNull();
    expect(requestRecoveryHref(conversationId, 'private prompt')).toBeNull();
  });
  it('keeps checking, needs-owner and unable-to-finish states distinct without implying edits', () => {
    expect(requestStatusNote('running')).toContain('Checking');
    expect(requestStatusNote('waiting_approval')).toContain('needs your approval');
    expect(requestStatusNote('failed')).toContain('Unable to finish');
    expect(requestStatusNote(null)).toContain('Unable to verify');
    expect(requestStatusNote('cancelled')).toBe(CANCELLED_REQUEST_NOTE);
    expect(CANCELLED_REQUEST_NOTE).not.toMatch(/edited|deleted|undone|no task started|calendar/i);
  });
  it('remount reads only the scoped unknown-stop identity; explicit Retry Stop uses the same operation', async () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => data.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        data.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        data.delete(key);
      }),
    };
    saveUnconfirmedStop(storage, 'session-a', conversationId, operationId);
    const restored = readUnconfirmedStop(storage, 'session-a', conversationId);
    expect(restored).toBe(operationId);
    expect(readUnconfirmedStop(storage, 'session-b', conversationId)).toBeNull();
    expect(readUnconfirmedStop(storage, 'session-a', taskId)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 503 }));
    expect(fetcher).not.toHaveBeenCalled();
    await requestChatOperationCancellation(
      { conversationId, clientOperationId: restored ?? '' },
      fetcher,
    );
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({
      conversationId,
      clientOperationId: operationId,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect([...data.values()]).toEqual([operationId]);
    saveUnconfirmedStop(storage, 'session-a', conversationId, null);
    expect(readUnconfirmedStop(storage, 'session-a', conversationId)).toBeNull();
  });
  it('same-task query selection retains a confirmed Stop receipt while its GET is pending; fresh or other tasks still check', () => {
    const receipt = cancelledRequestNote(taskId);
    expect(selectedRequestNote(receipt, taskId)).toBe(receipt);
    expect(receipt.confirmedCancellation).toBe(true);
    expect(receipt.retryable).toBe(false);
    const other = selectedRequestNote(receipt, operationId);
    expect(other.text).toContain('Checking');
    expect(other.taskId).toBe(operationId);
    expect(other.confirmedCancellation).toBeUndefined();
    const remount = selectedRequestNote(null, taskId);
    expect(remount.text).toContain('Checking');
    expect(remount.confirmedCancellation).toBeUndefined();
    const unconfirmed = selectedRequestNote(
      { text: CANCELLED_REQUEST_NOTE, retryable: false, taskId },
      taskId,
    );
    expect(unconfirmed.text).toContain('Checking');
    expect(unconfirmed.confirmedCancellation).toBeUndefined();
  });
});

import type { UIMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AsyncNote, AsyncTurn, TurnState } from './use-chat-polling';

const effects = vi.hoisted(() => ({ mount: null as null | (() => undefined | (() => void)) }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useRef: (current: unknown) => ({ current }),
  useEffect: (mount: () => undefined | (() => void)) => {
    effects.mount = mount;
  },
}));

import {
  CANCELLED_REQUEST_NOTE,
  recoveryTaskFromUrl,
  requestRecoveryHref,
} from './chat-request-recovery';
import { useChatPolling } from './use-chat-polling';

const conversationId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function usePollingHost(
  task = taskId,
  recoveryTaskId?: string | null,
  publicationEpochRef = { current: 0 },
  recoverySelectionRef = { current: { observationRevision: 0 } },
  deferMessages = false,
) {
  const asyncTurnRef = { current: { taskId: task, cursor: '' } as AsyncTurn | null };
  const notes: AsyncNote[] = [];
  const messages: unknown[] = [];
  const logRef = { current: [] as UIMessage[] };
  const cursorRef = { current: null as string | null };
  const serverIdsRef = { current: new Set<string>() };
  const setActivity = vi.fn(),
    setPollTrouble = vi.fn(),
    onTaskTerminal = vi.fn();
  const setAsyncTurn = vi.fn((value) => {
    asyncTurnRef.current = value;
  });
  const setAsyncNote = vi.fn((value) => {
    if (value) notes.push(value);
  });
  const pendingUpdates: Array<(current: UIMessage[]) => UIMessage[]> = [];
  const setMessages = vi.fn((update) => {
    if (deferMessages) {
      pendingUpdates.push(update);
      return;
    }
    logRef.current = update(logRef.current);
    messages.push(logRef.current);
  });
  useChatPolling({
    conversationId,
    recoveryTaskId,
    publicationEpochRef,
    recoverySelectionRef,
    asyncTurnRef,
    setAsyncTurn,
    setAsyncNote,
    setMessages,
    statusRef: { current: 'ready' },
    cursorRef,
    logRef,
    serverIdsRef,
    turnRef: { current: null as TurnState | null },
    pokePollRef: { current: null },
    setActivity,
    setLiveRecall: vi.fn(),
    setPollTrouble,
    onTaskTerminal,
  });
  const cleanup = effects.mount?.();
  return {
    notes,
    messages,
    asyncTurnRef,
    setAsyncTurn,
    setMessages,
    pendingUpdates,
    cursorRef,
    logRef,
    serverIdsRef,
    recoverySelectionRef,
    setActivity,
    setPollTrouble,
    onTaskTerminal,
    cleanup: cleanup as () => void,
  };
}
function response(status: string, messages: unknown[] = []) {
  return Response.json({ taskStatus: status, messages, nextCursor: null, hasMore: false });
}
beforeEach(() => {
  vi.useFakeTimers();
  const win = new EventTarget();
  Object.assign(win, { setTimeout, clearTimeout });
  const doc = new EventTarget();
  Object.assign(doc, { visibilityState: 'visible' });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('actual polling effect recovery lifecycle (controlled hook host)', () => {
  it('cancelled terminal poll and remount preserve uncertainty with zero dispatches', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response('cancelled'));
    vi.stubGlobal('fetch', fetcher);
    const first = usePollingHost();
    await flush();
    expect(first.notes.at(-1)).toEqual({ text: CANCELLED_REQUEST_NOTE, retryable: false, taskId });
    first.cleanup();
    const href = requestRecoveryHref(conversationId, taskId) ?? '';
    const second = usePollingHost(
      recoveryTaskFromUrl(`https://assistant.test${href}`, conversationId) ?? '',
    );
    await flush();
    expect(second.notes.at(-1)).toEqual(first.notes.at(-1));
    for (const [url, options] of fetcher.mock.calls) {
      expect(String(url)).toContain(
        `/api/chat/status?conversationId=${conversationId}&taskId=${taskId}`,
      );
      expect(options?.method).toBeUndefined();
    }
    second.cleanup();
  });
  it('shows an honest waiting note before the reported 159.737 seconds without changing task or network timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response('running')),
    );
    const mounted = usePollingHost();
    await flush();
    await vi.advanceTimersByTimeAsync(159_737);
    expect(mounted.notes.some((note) => note.text.includes('Checking this request'))).toBe(true);
    expect(mounted.notes.every((note) => !note.retryable)).toBe(true);
    expect(mounted.asyncTurnRef.current?.taskId).toBe(taskId);
    mounted.cleanup();
  });
  it('missing/foreign task remains unavailable; a late response after unmount cannot publish', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
    const missing = usePollingHost();
    await flush();
    expect(missing.notes.at(-1)?.text).toContain('Unable to verify');
    expect(missing.notes.at(-1)?.retryable).toBe(false);
    missing.cleanup();
    let resolve!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    const late = usePollingHost();
    late.cleanup();
    resolve(
      response('done', [
        { id: 'late', role: 'assistant', parts: [{ type: 'text', text: 'Late answer' }] },
      ]),
    );
    await flush();
    expect(late.notes).toEqual([]);
    expect(late.messages).toEqual([]);
  });
  it('A→B selection rejects deferred A before cleanup; Back/forward and clear perform GET observations only', async () => {
    const otherTask = '44444444-4444-4444-8444-444444444444';
    let answerA!: (value: Response) => void;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            answerA = resolve;
          }),
      )
      .mockImplementation(async () => response('cancelled'));
    vi.stubGlobal('fetch', fetcher);
    const a = usePollingHost(taskId, taskId);
    // Explicit navigation invalidates all publication before effect cleanup.
    a.recoverySelectionRef.current.observationRevision += 1;
    a.asyncTurnRef.current = { taskId: otherTask, cursor: '' };
    answerA(
      response('done', [
        { id: 'unrelated-a', role: 'assistant', parts: [{ type: 'text', text: 'A answer' }] },
      ]),
    );
    await flush();
    expect(a.notes).toEqual([]);
    expect(a.messages).toEqual([]);
    a.cleanup();
    const b = usePollingHost(otherTask, otherTask);
    await flush();
    expect(b.notes.at(-1)?.taskId).toBe(otherTask);
    b.cleanup(); // Browser Back selects A again.
    const back = usePollingHost(taskId, taskId);
    await flush();
    expect(back.notes.at(-1)?.taskId).toBe(taskId);
    back.cleanup(); // Forward selects B again.
    const forward = usePollingHost(otherTask, otherTask);
    await flush();
    expect(forward.notes.at(-1)?.taskId).toBe(otherTask);
    forward.asyncTurnRef.current = null;
    forward.cleanup(); // Back to chat clears selection.
    expect(forward.asyncTurnRef.current).toBeNull();
    for (const [url, options] of fetcher.mock.calls) {
      expect(String(url)).toContain('/api/chat/status?');
      expect(options?.method).toBeUndefined();
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('completed selected task with a newer cursor never treats an unrelated assistant row as its result', async () => {
    const fetcher = vi.fn(async () =>
      response('done', [
        {
          id: 'another-task-reply',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Other answer' }],
        },
      ]),
    );
    vi.stubGlobal('fetch', fetcher);
    const selected = usePollingHost(taskId, taskId);
    await flush();
    expect(selected.notes.at(-1)).toEqual({
      text: 'This request is marked complete. Check its saved reply for the result.',
      retryable: false,
      taskId,
    });
    expect(selected.asyncTurnRef.current).toBeNull();
    selected.cleanup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response('done')),
    );
    const noOldReply = usePollingHost(taskId, taskId);
    await flush();
    expect(noOldReply.notes.at(-1)).toEqual(selected.notes.at(-1));
    noOldReply.cleanup();
  });
  it('held pre-Stop running response cannot overwrite a newer cancellation receipt or advance its cursor', async () => {
    let held!: (value: Response) => void;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            held = resolve;
          }),
      )
      .mockImplementation(async () => response('cancelled'));
    vi.stubGlobal('fetch', fetcher);
    const epoch = { current: 0 };
    const selected = usePollingHost(taskId, taskId, epoch);
    epoch.current += 1; // Stop begins; an in-flight observation is now older.
    epoch.current += 1; // Confirmed cancellation receipt publishes its honest note.
    held(
      response('running', [
        {
          id: 'saved-late-answer',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Saved late answer' }],
        },
      ]),
    );
    await flush();
    expect(selected.notes).toEqual([]);
    expect(selected.logRef.current.map((message) => message.id)).toEqual(['saved-late-answer']);
    expect(selected.cursorRef.current).toBeNull();
    // The old read appends new durable content, never its running task state.
    await vi.advanceTimersByTimeAsync(2501);
    expect(selected.notes.at(-1)?.text).toBe(CANCELLED_REQUEST_NOTE);
    expect(selected.notes.at(-1)?.retryable).toBe(false);
    selected.cleanup();
    expect(fetcher.mock.calls.every(([, init]) => init?.method === undefined)).toBe(true);
  });
  it('Stop receipt also fences deferred JSON publication after the GET headers arrived', async () => {
    let decoded!: (value: unknown) => void;
    const held = response('running');
    vi.spyOn(held, 'json').mockImplementation(
      () =>
        new Promise((resolve) => {
          decoded = resolve;
        }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => held),
    );
    const epoch = { current: 0 };
    const mounted = usePollingHost(taskId, taskId, epoch);
    await flush();
    epoch.current += 1;
    decoded({
      taskStatus: 'running',
      messages: [
        { id: 'old', role: 'assistant', parts: [{ type: 'text', text: 'Old decoded reply' }] },
      ],
      nextCursor: 'old-cursor',
      hasMore: false,
    });
    await flush();
    expect(mounted.notes).toEqual([]);
    expect(mounted.logRef.current.map((message) => message.id)).toEqual(['old']);
    expect(mounted.cursorRef.current).toBeNull();
    mounted.cleanup();
  });
  it.each(['done', 'cancelled', 'failed'])(
    'retired same-thread %s read appends only new IDs without taking B state, cards, cursor or health',
    async (terminal) => {
      let resolve!: (value: Response) => void;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          () =>
            new Promise<Response>((done) => {
              resolve = done;
            }),
        ),
      );
      const mounted = usePollingHost();
      const known: UIMessage = {
        id: 'known',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Current content' }],
      };
      const owner: UIMessage = {
        id: 'owner-operation',
        role: 'user',
        metadata: { durableMessageId: 'owner-durable', channelMessageId: 'owner-channel' },
        parts: [{ type: 'text', text: 'Already visible owner turn' }],
      };
      mounted.setMessages(() => [known, owner]);
      mounted.serverIdsRef.current.add('server-known');
      mounted.asyncTurnRef.current = {
        taskId: '44444444-4444-4444-8444-444444444444',
        cursor: 'new-cursor',
      };
      mounted.cursorRef.current = 'new-cursor';
      resolve(
        Response.json({
          taskStatus: terminal,
          messages: [
            { ...known, parts: [{ type: 'text', text: 'Old overwrite' }] },
            {
              id: 'owner-durable',
              role: 'user',
              parts: [{ type: 'text', text: 'Duplicate durable owner row' }],
            },
            {
              id: 'owner-channel',
              role: 'user',
              parts: [{ type: 'text', text: 'Duplicate channel owner row' }],
            },
            {
              id: 'server-known',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Already known elsewhere' }],
            },
            {
              id: 'new-durable-a',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Saved late A answer' }],
            },
            {
              id: 'new-durable-a',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Duplicate ID' }],
            },
          ],
          refreshed: [{ ...known, parts: [{ type: 'text', text: 'Old card refresh' }] }],
          superseded: ['known'],
          activity: [{ toolName: 'old-task', status: 'failed', step: 1 }],
          nextCursor: 'old-cursor',
          hasMore: true,
        }),
      );
      await flush();
      expect(mounted.logRef.current).toEqual([
        known,
        owner,
        {
          id: 'new-durable-a',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Saved late A answer' }],
        },
      ]);
      expect(mounted.notes).toEqual([]);
      expect(mounted.setAsyncTurn).not.toHaveBeenCalled();
      expect(mounted.setActivity).not.toHaveBeenCalled();
      expect(mounted.setPollTrouble).not.toHaveBeenCalled();
      expect(mounted.onTaskTerminal).not.toHaveBeenCalled();
      expect(mounted.cursorRef.current).toBe('new-cursor');
      mounted.cleanup();
    },
  );
  it.each([401, 403, 404, 500])(
    'retired HTTP %s cannot change B auth/trouble or task state',
    async (status) => {
      let resolve!: (value: Response) => void;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          () =>
            new Promise<Response>((done) => {
              resolve = done;
            }),
        ),
      );
      const mounted = usePollingHost();
      mounted.asyncTurnRef.current = { taskId: '44444444-4444-4444-8444-444444444444', cursor: '' };
      resolve(new Response('{}', { status }));
      await flush();
      expect(mounted.setPollTrouble).not.toHaveBeenCalled();
      expect(mounted.setAsyncTurn).not.toHaveBeenCalled();
      expect(mounted.notes).toEqual([]);
      expect(mounted.messages).toEqual([]);
      mounted.cleanup();
    },
  );
  it('a deferred retired-row updater rechecks the hard navigation/session fence before rows or seen IDs publish', async () => {
    let resolve!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    const hard = { current: { observationRevision: 0 } };
    const mounted = usePollingHost(taskId, taskId, { current: 0 }, hard, true);
    mounted.asyncTurnRef.current = { taskId: '44444444-4444-4444-8444-444444444444', cursor: '' };
    resolve(
      response('done', [
        {
          id: 'queued-old',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Queued old answer' }],
        },
      ]),
    );
    await flush();
    expect(mounted.pendingUpdates).toHaveLength(1);
    hard.current.observationRevision += 1;
    const current: UIMessage[] = [];
    expect(mounted.pendingUpdates[0]?.(current)).toBe(current);
    expect(mounted.serverIdsRef.current.has('queued-old')).toBe(false);
    mounted.cleanup();
  });
});

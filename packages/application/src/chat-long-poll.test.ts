import type { Db } from '@assistant/db';
import type { ApplicationChatPersistence } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({ getChatUpdates: vi.fn() }));

// waitForChatUpdates is a loop around getChatUpdates; stubbing the inner read
// is what lets the holding behaviour be tested without a database.
vi.mock('./chat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chat.js')>();
  return { ...actual, getChatUpdates: stubs.getChatUpdates };
});

const { MAX_CHAT_WAIT_MS, waitForChatUpdates } = await import('./chat-long-poll.js');

const db = {} as Db;
const CONVERSATION = { conversationId: 'c1' };
const TASK = { conversationId: 'c1', taskId: 't1' };
const AGENT_ID = 'agent-1';

type WatchInput = Parameters<NonNullable<ApplicationChatPersistence['watchChatChanges']>>[0];

function watchableStore(onSubscribe?: (input: WatchInput) => void) {
  let watchInput: WatchInput | undefined;
  const close = vi.fn();
  const resolveAgent = vi.fn(async () => ({
    id: AGENT_ID,
    name: 'Assistant',
    email: 'assistant@example.test',
    timezone: 'UTC',
  }));
  const watchChatChanges = vi.fn(async (input: WatchInput) => {
    watchInput = input;
    onSubscribe?.(input);
    return { close };
  });
  return {
    store: {
      kind: 'application-chat-persistence',
      resolveAgent,
      watchChatChanges,
    } as unknown as ApplicationChatPersistence,
    close,
    resolveAgent,
    watchChatChanges,
    get watchInput() {
      return watchInput;
    },
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function updates(over: Partial<Record<string, unknown>> = {}) {
  return {
    taskStatus: 'running',
    messages: [],
    refreshed: [],
    superseded: [],
    nextCursor: null,
    hasMore: false,
    activity: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

afterEach(() => vi.useRealTimers());

describe('a poll that is not asked to wait', () => {
  it('answers immediately, exactly as before', async () => {
    stubs.getChatUpdates.mockResolvedValue(updates());

    const result = await waitForChatUpdates(db, CONVERSATION);

    expect(result).toMatchObject({ taskStatus: 'running' });
    expect(stubs.getChatUpdates).toHaveBeenCalledTimes(1);
  });

  it('reports a missing conversation rather than holding the connection open', async () => {
    stubs.getChatUpdates.mockResolvedValue(null);

    await expect(waitForChatUpdates(db, { ...TASK, waitMs: 10_000 })).resolves.toBeNull();
    expect(stubs.getChatUpdates).toHaveBeenCalledTimes(1);
  });
});

describe('a held poll returns the moment there is something to say', () => {
  it('does not open a watch without a task wait capability', async () => {
    const watched = watchableStore();
    stubs.getChatUpdates.mockResolvedValue(updates());

    await waitForChatUpdates(watched.store, { ...TASK, waitMs: 0 });

    expect(stubs.getChatUpdates).toHaveBeenCalledOnce();
    expect(watched.watchChatChanges).not.toHaveBeenCalled();
    expect(watched.resolveAgent).not.toHaveBeenCalled();
  });

  it('does not open a watcher when the canonical preflight rejects the task scope', async () => {
    const watched = watchableStore();
    stubs.getChatUpdates.mockResolvedValue(null);

    await expect(
      waitForChatUpdates(watched.store, { ...TASK, waitMs: MAX_CHAT_WAIT_MS }),
    ).resolves.toBeNull();

    expect(stubs.getChatUpdates).toHaveBeenCalledOnce();
    expect(watched.resolveAgent).not.toHaveBeenCalled();
    expect(watched.watchChatChanges).not.toHaveBeenCalled();
  });

  it('falls back to canonical polling when watch setup throws', async () => {
    vi.useFakeTimers();
    let durableAnswerReady = false;
    let reads = 0;
    const watched = watchableStore();
    watched.watchChatChanges.mockRejectedValueOnce(new Error('synthetic setup failure'));
    stubs.getChatUpdates.mockImplementation(async () => {
      reads += 1;
      return updates(
        durableAnswerReady ? { messages: [{ id: 'setup-fallback', text: 'Stored only.' }] } : {},
      );
    });
    const resultPromise = waitForChatUpdates(watched.store, { ...TASK, waitMs: 500 });

    await flushMicrotasks();
    expect(reads).toBe(1);
    expect(watched.watchChatChanges).toHaveBeenCalledOnce();
    expect(watched.close).not.toHaveBeenCalled();
    durableAnswerReady = true;
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(result?.messages).toEqual([{ id: 'setup-fallback', text: 'Stored only.' }]);
    expect(reads).toBe(2);
    vi.useRealTimers();
  });

  it('closes the watch if a canonical read errors', async () => {
    const watched = watchableStore();
    const readError = new Error('synthetic canonical read failure');
    stubs.getChatUpdates.mockResolvedValueOnce(updates()).mockRejectedValueOnce(readError);

    await expect(
      waitForChatUpdates(watched.store, { ...TASK, waitMs: MAX_CHAT_WAIT_MS }),
    ).rejects.toBe(readError);

    expect(stubs.getChatUpdates).toHaveBeenCalledTimes(2);
    expect(watched.close).toHaveBeenCalledOnce();
  });

  it('subscribes within the checked identity and re-reads canonically across registration', async () => {
    let changeDuringRegistration: WatchInput['onChange'] | undefined;
    let preflightReadsAtSubscribe = 0;
    let callbackCount = 0;
    let durableAnswerReady = false;
    let reads = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const watched = watchableStore((input) => {
      changeDuringRegistration = input.onChange;
      preflightReadsAtSubscribe = stubs.getChatUpdates.mock.calls.length;
      durableAnswerReady = true;
      input.onChange();
      callbackCount += 1;
    });
    stubs.getChatUpdates.mockImplementation(async () => {
      reads += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await Promise.resolve();
        return updates(
          durableAnswerReady
            ? { messages: [{ id: 'checked-final', text: 'Verified answer.' }] }
            : {},
        );
      } finally {
        inFlight -= 1;
      }
    });

    const result = await waitForChatUpdates(watched.store, {
      ...TASK,
      waitMs: MAX_CHAT_WAIT_MS,
    });

    expect(result?.messages).toEqual([{ id: 'checked-final', text: 'Verified answer.' }]);
    expect(changeDuringRegistration).toBeDefined();
    expect(callbackCount).toBe(1);
    expect(preflightReadsAtSubscribe).toBe(1);
    expect(reads).toBe(2); // Preflight plus post-subscribe canonical read.
    expect(maxInFlight).toBe(1);
    expect(watched.resolveAgent).toHaveBeenCalledOnce();
    expect(watched.watchChatChanges).toHaveBeenCalledOnce();
    expect(watched.watchChatChanges.mock.calls[0]?.[0]).toMatchObject({
      agentId: AGENT_ID,
      conversationId: 'c1',
      taskId: 't1',
    });
    expect(watched.watchChatChanges.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(watched.watchChatChanges.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(watched.close).toHaveBeenCalledOnce();
  });

  it('coalesces a burst during a canonical read and enforces the 500ms read floor', async () => {
    vi.useFakeTimers();
    let durableAnswerReady = false;
    let reads = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    let change: WatchInput['onChange'] | undefined;
    let callbackCount = 0;
    let releaseRead: (() => void) | undefined;
    let thirdReadStarted!: () => void;
    const thirdRead = new Promise<void>((resolve) => {
      thirdReadStarted = resolve;
    });
    const watched = watchableStore((input) => {
      change = () => {
        callbackCount += 1;
        input.onChange();
      };
    });
    stubs.getChatUpdates.mockImplementation(async () => {
      reads += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (reads === 3) {
          thirdReadStarted();
          await new Promise<void>((resolve) => {
            releaseRead = resolve;
          });
        } else {
          await Promise.resolve();
        }
        return updates(
          durableAnswerReady
            ? { messages: [{ id: 'burst-final', text: 'Canonical answer.' }] }
            : {},
        );
      } finally {
        inFlight -= 1;
      }
    });
    let settled = false;
    const resultPromise = waitForChatUpdates(watched.store, {
      ...TASK,
      waitMs: MAX_CHAT_WAIT_MS,
    }).then((result) => {
      settled = true;
      return result;
    });

    await flushMicrotasks();
    expect(reads).toBe(2);
    expect(change).toBeDefined();
    change?.();
    await thirdRead;
    for (let i = 0; i < 20; i += 1) change?.();
    expect(callbackCount).toBe(21);
    releaseRead?.();
    await flushMicrotasks();
    expect(reads).toBe(3);
    expect(maxInFlight).toBe(1);
    expect(settled).toBe(false);

    durableAnswerReady = true;
    await vi.advanceTimersByTimeAsync(499);
    await flushMicrotasks();
    expect(reads).toBe(3);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(result?.messages).toEqual([{ id: 'burst-final', text: 'Canonical answer.' }]);
    expect(reads).toBe(4); // One coalesced canonical read after the cooldown.
    expect(maxInFlight).toBe(1);
    expect(watched.close).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('caps fast canonical reads and falls back to the existing poll cadence', async () => {
    vi.useFakeTimers();
    let durableAnswerReady = false;
    let reads = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    let change: WatchInput['onChange'] | undefined;
    let callbackCount = 0;
    const watched = watchableStore((input) => {
      change = () => {
        callbackCount += 1;
        input.onChange();
      };
    });
    stubs.getChatUpdates.mockImplementation(async () => {
      reads += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await Promise.resolve();
        return updates(
          durableAnswerReady ? { messages: [{ id: 'cap-final', text: 'Saved answer.' }] } : {},
        );
      } finally {
        inFlight -= 1;
      }
    });
    const resultPromise = waitForChatUpdates(watched.store, {
      ...TASK,
      waitMs: MAX_CHAT_WAIT_MS,
    });

    await flushMicrotasks();
    expect(reads).toBe(2);
    expect(change).toBeDefined();
    change?.();
    await flushMicrotasks();
    expect(reads).toBe(3); // First hint may wake immediately.
    for (let hintRead = 2; hintRead <= 4; hintRead += 1) {
      change?.();
      await vi.advanceTimersByTimeAsync(500);
      await flushMicrotasks();
      expect(reads).toBe(2 + hintRead);
    }
    expect(callbackCount).toBe(4);
    durableAnswerReady = true;
    change?.(); // Fifth fast read is over budget; close and use ordinary polling.
    expect(callbackCount).toBe(5);
    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();
    expect(watched.close).toHaveBeenCalledOnce();
    expect(reads).toBe(6);
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(result?.messages).toEqual([{ id: 'cap-final', text: 'Saved answer.' }]);
    expect(reads).toBe(7); // Initial, subscribe reread, four hints, one fallback.
    expect(maxInFlight).toBe(1);
    expect(watched.watchChatChanges).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('closes a noisy watcher after 64 callbacks and falls back without retrying it', async () => {
    vi.useFakeTimers();
    let durableAnswerReady = false;
    let reads = 0;
    let change: WatchInput['onChange'] | undefined;
    let callbackCount = 0;
    const watched = watchableStore((input) => {
      change = () => {
        callbackCount += 1;
        input.onChange();
      };
    });
    stubs.getChatUpdates.mockImplementation(async () => {
      reads += 1;
      await Promise.resolve();
      return updates(
        durableAnswerReady ? { messages: [{ id: 'noise-final', text: 'Stored reply.' }] } : {},
      );
    });
    const resultPromise = waitForChatUpdates(watched.store, {
      ...TASK,
      waitMs: MAX_CHAT_WAIT_MS,
    });

    await flushMicrotasks();
    expect(reads).toBe(2);
    expect(change).toBeDefined();
    for (let callback = 0; callback < 65; callback += 1) change?.();
    expect(callbackCount).toBe(65);
    await flushMicrotasks();
    expect(watched.close).toHaveBeenCalledOnce();
    expect(reads).toBe(2);
    durableAnswerReady = true;
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(result?.messages).toEqual([{ id: 'noise-final', text: 'Stored reply.' }]);
    expect(reads).toBe(3);
    expect(watched.watchChatChanges).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it.each(['abort', 'watch-error', 'deadline'] as const)(
    'closes the watcher on %s and keeps fallback reads scoped',
    async (ending) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      let durableAnswerReady = false;
      let reads = 0;
      let change: WatchInput | undefined;
      const watched = watchableStore((input) => {
        change = input;
      });
      stubs.getChatUpdates.mockImplementation(async () => {
        reads += 1;
        await Promise.resolve();
        return updates(
          durableAnswerReady
            ? { messages: [{ id: `end-${ending}`, text: 'Canonical only.' }] }
            : {},
        );
      });
      const resultPromise = waitForChatUpdates(watched.store, {
        ...TASK,
        waitMs: ending === 'deadline' ? 500 : MAX_CHAT_WAIT_MS,
        signal: controller.signal,
      });
      await flushMicrotasks();
      expect(reads).toBe(2);
      expect(change).toBeDefined();

      if (ending === 'abort') {
        controller.abort();
        const result = await resultPromise;
        expect(result?.messages).toEqual([]);
        expect(reads).toBe(2);
      } else if (ending === 'watch-error') {
        change?.onError(new Error('synthetic listener failure'));
        expect(watched.close).toHaveBeenCalledOnce();
        durableAnswerReady = true;
        await vi.advanceTimersByTimeAsync(500);
        const result = await resultPromise;
        expect(result?.messages).toEqual([{ id: `end-${ending}`, text: 'Canonical only.' }]);
        expect(reads).toBe(3);
      } else {
        await vi.advanceTimersByTimeAsync(500);
        const result = await resultPromise;
        expect(result?.messages).toEqual([]);
        expect(reads).toBe(3); // Final canonical read after the deadline wake.
      }

      expect(watched.close).toHaveBeenCalledOnce();
      expect(watched.watchChatChanges).toHaveBeenCalledOnce();
      vi.useRealTimers();
    },
  );

  it.each(['abort', 'deadline'] as const)(
    'closes while a post-subscribe canonical read is held by %s',
    async (ending) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const postSubscribeStarted = deferred<void>();
      const releasePostSubscribe = deferred<void>();
      let reads = 0;
      let inFlight = 0;
      let maxInFlight = 0;
      const watched = watchableStore();
      stubs.getChatUpdates.mockImplementation(async () => {
        reads += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          if (reads === 2) {
            postSubscribeStarted.resolve();
            await releasePostSubscribe.promise;
          }
          return updates();
        } finally {
          inFlight -= 1;
        }
      });
      const resultPromise = waitForChatUpdates(watched.store, {
        ...TASK,
        waitMs: ending === 'deadline' ? 500 : MAX_CHAT_WAIT_MS,
        signal: controller.signal,
      });

      await postSubscribeStarted.promise;
      if (ending === 'abort') controller.abort();
      else await vi.advanceTimersByTimeAsync(500);
      const result = await resultPromise;

      expect(result?.messages).toEqual([]);
      expect(reads).toBe(2);
      expect(maxInFlight).toBe(1);
      expect(watched.close).toHaveBeenCalledOnce();
      releasePostSubscribe.resolve();
      await flushMicrotasks();
      expect(inFlight).toBe(0);
      vi.useRealTimers();
    },
  );

  it('closes a listener that finishes setup after the held poll deadline', async () => {
    vi.useFakeTimers();
    const setupStarted = deferred<void>();
    const finishSetup = deferred<{ close(): void }>();
    const close = vi.fn();
    const watched = watchableStore();
    const lateWatch = vi.fn(async () => {
      setupStarted.resolve();
      return finishSetup.promise;
    });
    const store = {
      ...(watched.store as unknown as Record<string, unknown>),
      watchChatChanges: lateWatch,
    } as unknown as ApplicationChatPersistence;
    stubs.getChatUpdates.mockResolvedValue(updates());
    const resultPromise = waitForChatUpdates(store, { ...TASK, waitMs: 500 });

    await setupStarted.promise;
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;
    expect(result?.messages).toEqual([]);
    expect(lateWatch).toHaveBeenCalledOnce();
    expect(stubs.getChatUpdates).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();
    finishSetup.resolve({ close });
    await flushMicrotasks();
    expect(close).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('waits through quiet reads and answers on the reply', async () => {
    stubs.getChatUpdates
      .mockResolvedValueOnce(updates())
      .mockResolvedValueOnce(updates())
      .mockResolvedValueOnce(updates({ messages: [{ id: 'm1' }] }));

    const result = await waitForChatUpdates(db, { ...TASK, waitMs: MAX_CHAT_WAIT_MS });

    expect(result?.messages).toHaveLength(1);
    expect(stubs.getChatUpdates).toHaveBeenCalledTimes(3);
  });

  it('answers on a finished task even when it produced no new message', async () => {
    stubs.getChatUpdates
      .mockResolvedValueOnce(updates())
      .mockResolvedValueOnce(updates({ taskStatus: 'failed' }));

    const result = await waitForChatUpdates(db, { ...TASK, waitMs: MAX_CHAT_WAIT_MS });

    expect(result?.taskStatus).toBe('failed');
    expect(stubs.getChatUpdates).toHaveBeenCalledTimes(2);
  });

  it('answers on rows the client must remove from what it is showing', async () => {
    stubs.getChatUpdates
      .mockResolvedValueOnce(updates())
      .mockResolvedValueOnce(updates({ superseded: ['m0'] }));

    const result = await waitForChatUpdates(db, { ...TASK, waitMs: MAX_CHAT_WAIT_MS });

    expect(result?.superseded).toEqual(['m0']);
  });

  it('does not hold a backlog back — the client loops straight on for the rest', async () => {
    stubs.getChatUpdates.mockResolvedValue(updates({ hasMore: true }));

    const result = await waitForChatUpdates(db, { ...TASK, waitMs: MAX_CHAT_WAIT_MS });

    expect(result?.hasMore).toBe(true);
    expect(stubs.getChatUpdates).toHaveBeenCalledTimes(1);
  });

  it('answers when a tool moves, so the progress indicator keeps up', async () => {
    const running = { step: 1, toolName: 'gmail.search', status: 'running' };
    stubs.getChatUpdates
      .mockResolvedValueOnce(updates({ activity: [running] }))
      .mockResolvedValueOnce(updates({ activity: [running] }))
      .mockResolvedValueOnce(
        updates({ activity: [{ step: 2, toolName: 'gmail.send', status: 'running' }] }),
      );

    const result = await waitForChatUpdates(db, { ...TASK, waitMs: MAX_CHAT_WAIT_MS });

    // The tool already running on the first read is not news: the response
    // that sent this client back here already carried it.
    expect(result?.activity).toEqual([{ step: 2, toolName: 'gmail.send', status: 'running' }]);
    expect(stubs.getChatUpdates).toHaveBeenCalledTimes(3);
  });

  it('keeps holding for re-read decision cards, which every tick returns anyway', async () => {
    // refreshed is not news — treating it as news would end every hold at once
    // and quietly turn the long poll back into a fast one.
    stubs.getChatUpdates.mockResolvedValue(updates({ refreshed: [{ id: 'card-1' }] }));

    const result = await waitForChatUpdates(db, { ...TASK, waitMs: 1_200 });

    expect(result?.messages).toHaveLength(0);
    expect(stubs.getChatUpdates.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('a held poll gives up politely', () => {
  it.each([false, true])(
    'bounds an unchanged full 25-second virtual hold (watch enabled: %s)',
    async (withWatch) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const timers = vi.spyOn(globalThis, 'setTimeout');
      const watched = watchableStore();
      let inFlight = 0;
      let maxInFlight = 0;
      stubs.getChatUpdates.mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await Promise.resolve();
          return updates();
        } finally {
          inFlight -= 1;
        }
      });
      try {
        const result = waitForChatUpdates(withWatch ? watched.store : db, {
          ...TASK,
          waitMs: MAX_CHAT_WAIT_MS,
        });
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(withWatch ? 2 : 1);
        await vi.advanceTimersByTimeAsync(MAX_CHAT_WAIT_MS);
        expect((await result)?.messages).toEqual([]);
        expect(Date.now()).toBe(25_000);
        expect(stubs.getChatUpdates).toHaveBeenCalledTimes(withWatch ? 52 : 51);
        expect(timers.mock.calls.filter(([, delay]) => delay === 500)).toHaveLength(50);
        // An unsupported adapter cancels this setup deadline before polling;
        // a supported adapter keeps it for the held request's lifetime.
        expect(timers.mock.calls.filter(([, delay]) => delay === MAX_CHAT_WAIT_MS)).toHaveLength(1);
        expect(maxInFlight).toBe(1);
        expect(inFlight).toBe(0);
        expect(watched.watchChatChanges).toHaveBeenCalledTimes(withWatch ? 1 : 0);
        expect(watched.close).toHaveBeenCalledTimes(withWatch ? 1 : 0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        timers.mockRestore();
      }
    },
  );

  it('opens a fresh same-cursor wait after disconnect without replaying an old hint', async () => {
    vi.useFakeTimers();
    const watched = watchableStore();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const input = { ...TASK, cursor: 'same-cursor', waitMs: MAX_CHAT_WAIT_MS };
    let committed = false;
    stubs.getChatUpdates.mockImplementation(async () =>
      updates(
        committed
          ? {
              messages: [{ id: 'durable-reply', text: 'Stored answer.' }],
              nextCursor: 'after-reply',
            }
          : {},
      ),
    );

    const first = waitForChatUpdates(watched.store, { ...input, signal: firstController.signal });
    await flushMicrotasks();
    const oldWatch = watched.watchInput;
    firstController.abort();
    expect((await first)?.messages).toEqual([]);
    expect(watched.close).toHaveBeenCalledOnce();

    const second = waitForChatUpdates(watched.store, { ...input, signal: secondController.signal });
    await flushMicrotasks();
    const newWatch = watched.watchInput;
    expect(newWatch?.signal).not.toBe(oldWatch?.signal);
    expect(watched.watchChatChanges).toHaveBeenCalledTimes(2);
    expect(stubs.getChatUpdates).toHaveBeenCalledTimes(4);
    oldWatch?.onChange();
    await flushMicrotasks();
    expect(stubs.getChatUpdates).toHaveBeenCalledTimes(4);

    committed = true;
    newWatch?.onChange();
    expect(await second).toMatchObject({
      messages: [{ id: 'durable-reply', text: 'Stored answer.' }],
      nextCursor: 'after-reply',
    });
    expect(stubs.getChatUpdates).toHaveBeenCalledTimes(5);
    expect(watched.close).toHaveBeenCalledTimes(2);
    for (const [, readInput] of stubs.getChatUpdates.mock.calls) {
      expect(readInput).toMatchObject({
        conversationId: 'c1',
        taskId: 't1',
        cursor: 'same-cursor',
      });
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns the quiet answer once the budget runs out', async () => {
    stubs.getChatUpdates.mockResolvedValue(updates());

    const started = Date.now();
    const result = await waitForChatUpdates(db, { ...TASK, waitMs: 1_200 });

    expect(result).toMatchObject({ messages: [] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
  });

  it('caps a caller that asks to be held longer than we are willing to hold', async () => {
    stubs.getChatUpdates.mockResolvedValue(updates());
    const started = Date.now();

    // Far beyond the cap; if it were honoured this test would time out rather
    // than return, which is the failure this pins.
    await waitForChatUpdates(db, {
      ...TASK,
      waitMs: 10 * 60 * 1_000,
      signal: AbortSignal.timeout(1_500),
    });

    expect(Date.now() - started).toBeLessThan(MAX_CHAT_WAIT_MS);
  });

  it('stops as soon as the caller hangs up', async () => {
    stubs.getChatUpdates.mockResolvedValue(updates());
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 700);

    const started = Date.now();
    await waitForChatUpdates(db, {
      ...TASK,
      waitMs: MAX_CHAT_WAIT_MS,
      signal: controller.signal,
    });

    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('never holds an already-aborted request', async () => {
    stubs.getChatUpdates.mockResolvedValue(updates());

    const result = await waitForChatUpdates(db, {
      ...TASK,
      waitMs: MAX_CHAT_WAIT_MS,
      signal: AbortSignal.abort(),
    });

    expect(result).toMatchObject({ messages: [] });
    expect(stubs.getChatUpdates).toHaveBeenCalledTimes(1);
  });
});

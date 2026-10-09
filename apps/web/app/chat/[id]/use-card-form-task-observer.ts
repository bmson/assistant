'use client';

import { useEffect, useRef } from 'react';
import { cardFormCallbackGeneration } from './card-form-operations';

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const MAX_DELAY_MS = 30_000;

export interface ObservedCardFormTask {
  taskId: string;
  cursor?: string;
}

/**
 * Observe the one exact accepted/competing form task independently from the
 * chat's foreground turn. This lets the owner answer a parked task in chat
 * without replacing the durable form-task receipt or cursor.
 */
export function useCardFormTaskObserver(input: {
  conversationId: string;
  task: ObservedCardFormTask | null;
  onTerminal: (taskId: string, status: 'done' | 'failed' | 'cancelled') => void;
  onUnavailable?: (taskId: string) => void;
}): void {
  const onTerminalRef = useRef(input.onTerminal);
  onTerminalRef.current = input.onTerminal;
  const onUnavailableRef = useRef(input.onUnavailable);
  onUnavailableRef.current = input.onUnavailable;
  const conversationId = input.conversationId;
  const taskId = input.task?.taskId;
  const cursor = input.task?.cursor;

  useEffect(() => {
    if (!taskId) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    let delayMs = 2_000;
    const generation = cardFormCallbackGeneration();
    let poll: () => Promise<void>;
    let onVisibility = () => {};
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      request?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    const schedule = (delay: number) => {
      if (!stopped && !document.hidden)
        timer = setTimeout(() => {
          void poll();
        }, delay);
    };
    poll = async () => {
      if (stopped || document.hidden) return;
      request = new AbortController();
      try {
        const url = new URL('/api/chat/status', window.location.origin);
        url.searchParams.set('conversationId', conversationId);
        url.searchParams.set('taskId', taskId);
        if (cursor) url.searchParams.set('cursor', cursor);
        url.searchParams.set('wait', '0');
        const response = await fetch(url, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          signal: request.signal,
        });
        if (stopped || generation !== cardFormCallbackGeneration()) return;
        if (response.status === 401 || response.status === 403) {
          stop();
          onUnavailableRef.current?.(taskId);
          return;
        }
        if (!response.ok) throw new Error('Task status is temporarily unavailable.');
        const value = (await response.json()) as { taskStatus?: unknown };
        if (stopped || generation !== cardFormCallbackGeneration()) return;
        if (typeof value.taskStatus === 'string' && TERMINAL.has(value.taskStatus)) {
          stop();
          onTerminalRef.current(taskId, value.taskStatus as 'done' | 'failed' | 'cancelled');
          return;
        }
        delayMs = Math.min(MAX_DELAY_MS, Math.round(delayMs * 1.5));
      } catch {
        if (stopped || request.signal.aborted) return;
        delayMs = Math.min(MAX_DELAY_MS, Math.round(delayMs * 1.7));
      }
      schedule(delayMs);
    };
    onVisibility = () => {
      if (document.hidden) {
        if (timer) clearTimeout(timer);
        timer = undefined;
        request?.abort();
      } else {
        delayMs = 2_000;
        void poll();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    void poll();
    return stop;
  }, [conversationId, taskId, cursor]);
}

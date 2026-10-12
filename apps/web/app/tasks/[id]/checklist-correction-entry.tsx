'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  type ChecklistCancellationRequest,
  cancelActivityChecklistItem,
  reconcileActivityChecklistCancellation,
} from './checklist-cancellation-client.js';
import {
  type ChecklistCorrectionRequest,
  reconcileActivityChecklistCorrection,
  saveActivityChecklistCorrection,
} from './checklist-correction-client.js';

interface PendingLookup {
  id: string;
  label: string;
}

interface CancellableItem {
  id: string;
  label: string;
}

export function ChecklistCorrectionEntry({
  taskId,
  ownerScope,
  revision,
  cancellationRevision = 0,
  items,
  cancellableItems = [],
}: {
  taskId: string;
  ownerScope: string;
  revision: number;
  cancellationRevision?: number;
  items: PendingLookup[];
  cancellableItems?: CancellableItem[];
}) {
  const router = useRouter();
  const scope = `${ownerScope}:${taskId}:${revision}:${cancellationRevision}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const [selected, setSelected] = useState<PendingLookup | null>(null);
  const [draft, setDraft] = useState('');
  const [attempt, setAttempt] = useState<ChecklistCorrectionRequest | null>(null);
  const [status, setStatus] = useState<'editing' | 'saving' | 'unknown' | 'saved' | 'error'>(
    'editing',
  );
  const [message, setMessage] = useState('');
  const [cancelTarget, setCancelTarget] = useState<CancellableItem | null>(null);
  const [cancelAttempt, setCancelAttempt] = useState<ChecklistCancellationRequest | null>(null);
  const [cancelStatus, setCancelStatus] = useState<
    'confirming' | 'saving' | 'unknown' | 'cancelled' | 'error'
  >('confirming');
  const [cancelMessage, setCancelMessage] = useState('');
  const [confirmedCancellationItemId, setConfirmedCancellationItemId] = useState<string | null>(
    null,
  );
  const displayItems = [
    ...cancellableItems,
    ...items.filter((item) => !cancellableItems.some((candidate) => candidate.id === item.id)),
  ];

  useEffect(() => {
    scopeRef.current = scope;
    mountedRef.current = true;
    const generation = ++generationRef.current;
    setSelected(null);
    setDraft('');
    setAttempt(null);
    setStatus('editing');
    setMessage('');
    setCancelTarget(null);
    setCancelAttempt(null);
    setCancelStatus('confirming');
    setCancelMessage('');
    setConfirmedCancellationItemId(null);
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
      mountedRef.current = false;
      busyRef.current = false;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [scope]);

  if (items.length === 0 && cancellableItems.length === 0) return null;

  function start(item: PendingLookup) {
    if (busyRef.current) return;
    setCancelTarget(null);
    setSelected(item);
    setDraft('');
    setAttempt(null);
    setStatus('editing');
    setMessage('');
  }

  function isCurrent(operationScope: string, generation: number) {
    return (
      mountedRef.current &&
      scopeRef.current === operationScope &&
      generationRef.current === generation
    );
  }

  async function save(request: ChecklistCorrectionRequest) {
    if (busyRef.current) return;
    busyRef.current = true;
    const operationScope = scope;
    const generation = generationRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setAttempt(request);
    setStatus('saving');
    setMessage('');
    try {
      const result = await saveActivityChecklistCorrection(request, fetch, controller.signal);
      if (!isCurrent(operationScope, generation)) return;
      if (result.kind === 'saved') {
        setStatus('saved');
        setMessage('Lookup change saved.');
        router.refresh();
      } else if (result.kind === 'unknown') {
        setStatus('unknown');
        setMessage('I couldn’t confirm whether this change was saved. Your text is still here.');
      } else {
        setStatus('error');
        setMessage(result.message);
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (isCurrent(operationScope, generation)) busyRef.current = false;
    }
  }

  async function checkStatus() {
    if (!attempt || busyRef.current) return;
    busyRef.current = true;
    const operationScope = scope;
    const generation = generationRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus('saving');
    setMessage('Checking Activity…');
    try {
      const matched = await reconcileActivityChecklistCorrection(
        attempt,
        fetch,
        3_000,
        controller.signal,
      );
      if (!isCurrent(operationScope, generation)) return;
      if (matched) {
        setStatus('saved');
        setMessage('Lookup change saved.');
        router.refresh();
      } else {
        setStatus('unknown');
        setMessage('Activity still cannot confirm the change. Your text is still here.');
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (isCurrent(operationScope, generation)) busyRef.current = false;
    }
  }

  function startCancellation(item: CancellableItem) {
    if (busyRef.current) return;
    setSelected(null);
    setCancelTarget(item);
    setCancelAttempt(null);
    setCancelStatus('confirming');
    setCancelMessage('');
  }

  async function cancelSelected(request?: ChecklistCancellationRequest) {
    const attempt =
      request ??
      cancelAttempt ??
      (cancelTarget
        ? {
            taskId,
            itemId: cancelTarget.id,
            expectedRevision: revision,
            expectedCancellationRevision: cancellationRevision,
            ownerMessageId: crypto.randomUUID(),
          }
        : null);
    if (!attempt || busyRef.current) return;
    busyRef.current = true;
    const operationScope = scope;
    const generation = generationRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setCancelAttempt(attempt);
    setCancelStatus('saving');
    setCancelMessage('');
    try {
      const result = await cancelActivityChecklistItem(attempt, fetch, controller.signal);
      if (!isCurrent(operationScope, generation)) return;
      if (result.kind === 'cancelled') {
        setCancelStatus('cancelled');
        setCancelMessage('Cancellation confirmed.');
        setConfirmedCancellationItemId(attempt.itemId);
        router.refresh();
      } else if (result.kind === 'unknown') {
        setCancelStatus('unknown');
        setCancelMessage(
          'I couldn’t confirm whether this item was cancelled. Its status is unchanged here.',
        );
      } else {
        setCancelStatus('error');
        setCancelMessage(result.message);
        router.refresh();
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (isCurrent(operationScope, generation)) busyRef.current = false;
    }
  }

  async function checkCancellationStatus() {
    if (!cancelAttempt || busyRef.current) return;
    busyRef.current = true;
    const operationScope = scope;
    const generation = generationRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setCancelStatus('saving');
    setCancelMessage('Checking Activity…');
    try {
      const matched = await reconcileActivityChecklistCancellation(
        cancelAttempt,
        fetch,
        3_000,
        controller.signal,
      );
      if (!isCurrent(operationScope, generation)) return;
      if (matched) {
        setCancelStatus('cancelled');
        setCancelMessage('Cancellation confirmed.');
        setConfirmedCancellationItemId(cancelAttempt.itemId);
        router.refresh();
      } else {
        setCancelStatus('unknown');
        setCancelMessage(
          'Activity still cannot confirm the cancellation. Its status is unchanged here.',
        );
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (isCurrent(operationScope, generation)) busyRef.current = false;
    }
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !draft.trim() || status === 'saving' || status === 'unknown') return;
    const request = {
      taskId,
      itemId: selected.id,
      expectedRevision: revision,
      ownerMessageId: crypto.randomUUID(),
      replacementLabel: draft.trim(),
    };
    void save(request);
  }

  return (
    <section className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-950/20">
      <h2 className="text-sm font-semibold text-amber-950 dark:text-amber-100">
        {items.length > 0 && cancellableItems.length > 0
          ? 'Update this request'
          : items.length > 0
            ? 'Change a lookup request'
            : 'Cancel an unfinished request'}
      </h2>
      <p className="mt-1 text-xs leading-5 text-amber-900 dark:text-amber-200">
        {cancellableItems.length > 0
          ? 'Choose one unfinished item. Completed work stays unchanged.'
          : 'Choose one unfinished lookup and describe the replacement. Completed work stays unchanged.'}
      </p>
      <ul className="mt-3 space-y-2">
        {displayItems.map((item) => {
          const canChangeLookup = items.some((lookup) => lookup.id === item.id);
          const canCancel = cancellableItems.some((candidate) => candidate.id === item.id);
          return (
            <li
              key={item.id}
              className={`grid min-w-0 gap-2 rounded-lg border bg-white/70 px-3 py-2 dark:bg-slate-950/30 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center ${selected?.id === item.id ? 'border-accent' : 'border-amber-200/80 dark:border-amber-900/50'}`}
            >
              <span className="min-w-0 break-words text-sm">{item.label}</span>
              <div className="flex flex-wrap items-center gap-2">
                {canChangeLookup ? (
                  <button
                    type="button"
                    className="min-h-11 min-w-11 self-start rounded-lg px-2 text-left text-sm font-medium text-accent hover:underline sm:self-auto"
                    onClick={() => start(item)}
                    disabled={
                      status === 'saving' ||
                      status === 'unknown' ||
                      cancelStatus === 'saving' ||
                      cancelStatus === 'unknown'
                    }
                    aria-pressed={selected?.id === item.id}
                  >
                    Change lookup
                  </button>
                ) : null}
                {canCancel ? (
                  <button
                    type="button"
                    className="min-h-11 min-w-11 self-start rounded-lg px-2 text-left text-sm font-medium text-accent hover:underline sm:self-auto"
                    onClick={() => startCancellation(item)}
                    disabled={
                      confirmedCancellationItemId === item.id ||
                      cancelStatus === 'saving' ||
                      cancelStatus === 'unknown' ||
                      status === 'saving' ||
                      status === 'unknown'
                    }
                    aria-label={`Cancel ${item.label}`}
                  >
                    Cancel item
                  </button>
                ) : null}
              </div>
              {cancelTarget?.id === item.id ? (
                <div className="grid gap-2 sm:col-span-2">
                  <p className="text-sm text-amber-950 dark:text-amber-100">
                    Cancel “{item.label}”? Only this item will be stopped.
                  </p>
                  {cancelStatus === 'unknown' && cancelAttempt ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="min-h-11 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white"
                        onClick={() => void checkCancellationStatus()}
                      >
                        Check status
                      </button>
                      <button
                        type="button"
                        className="min-h-11 rounded-lg px-2 py-2 text-sm font-medium text-accent hover:underline"
                        onClick={() => void cancelSelected(cancelAttempt)}
                      >
                        Try the same cancellation again
                      </button>
                    </div>
                  ) : cancelStatus === 'cancelled' || cancelStatus === 'error' ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <p aria-live="polite" className="text-sm text-amber-950 dark:text-amber-100">
                        {cancelMessage}
                      </p>
                      <button
                        type="button"
                        className="min-h-11 rounded-lg px-2 py-2 text-sm font-medium text-accent hover:underline"
                        onClick={() => setCancelTarget(null)}
                      >
                        Done
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="min-h-11 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                        onClick={() => void cancelSelected()}
                        disabled={cancelStatus === 'saving'}
                      >
                        {cancelStatus === 'saving' ? 'Cancelling…' : 'Cancel this item'}
                      </button>
                      <button
                        type="button"
                        className="min-h-11 rounded-lg px-2 py-2 text-sm font-medium text-accent hover:underline"
                        onClick={() => setCancelTarget(null)}
                        disabled={cancelStatus === 'saving'}
                      >
                        Keep it
                      </button>
                      {cancelMessage ? (
                        <p
                          aria-live="polite"
                          className="text-sm text-amber-950 dark:text-amber-100"
                        >
                          {cancelMessage}
                        </p>
                      ) : null}
                    </div>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {selected ? (
        <form className="mt-3 grid gap-2" onSubmit={submit}>
          <label className="grid gap-1 text-xs font-medium text-amber-950 dark:text-amber-100">
            Replacement lookup
            <textarea
              className="min-h-24 min-w-0 w-full resize-y rounded-lg border border-edge bg-white px-3 py-2 text-sm text-strong dark:bg-slate-950"
              rows={3}
              maxLength={500}
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              disabled={status === 'saving' || status === 'unknown' || status === 'saved'}
              placeholder="Describe what you want looked up"
              required
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            {status === 'unknown' && attempt ? (
              <>
                <button
                  type="button"
                  className="min-h-11 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white"
                  onClick={() => void checkStatus()}
                >
                  Check status
                </button>
                <button
                  type="button"
                  className="min-h-11 rounded-lg px-2 text-sm font-medium text-accent hover:underline"
                  onClick={() => void save(attempt)}
                >
                  Try the same change again
                </button>
              </>
            ) : (
              <button
                type="submit"
                className="min-h-11 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={status === 'saving' || status === 'saved' || draft.trim().length < 3}
              >
                {status === 'saving' ? 'Saving…' : 'Save lookup change'}
              </button>
            )}
          </div>
          {message ? (
            <p aria-live="polite" className="text-sm text-amber-950 dark:text-amber-100">
              {message}
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}

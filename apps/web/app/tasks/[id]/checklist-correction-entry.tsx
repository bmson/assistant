'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  type ChecklistCorrectionRequest,
  reconcileActivityChecklistCorrection,
  saveActivityChecklistCorrection,
} from './checklist-correction-client.js';

interface PendingLookup {
  id: string;
  label: string;
}

export function ChecklistCorrectionEntry({
  taskId,
  ownerScope,
  revision,
  items,
}: {
  taskId: string;
  ownerScope: string;
  revision: number;
  items: PendingLookup[];
}) {
  const router = useRouter();
  const scope = `${ownerScope}:${taskId}:${revision}`;
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

  useEffect(() => {
    scopeRef.current = scope;
    mountedRef.current = true;
    const generation = ++generationRef.current;
    setSelected(null);
    setDraft('');
    setAttempt(null);
    setStatus('editing');
    setMessage('');
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
      mountedRef.current = false;
      busyRef.current = false;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [scope]);

  if (items.length === 0) return null;

  function start(item: PendingLookup) {
    if (busyRef.current) return;
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
        Change a lookup request
      </h2>
      <p className="mt-1 text-xs leading-5 text-amber-900 dark:text-amber-200">
        Choose one unfinished lookup and describe the replacement. Completed work stays unchanged.
      </p>
      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <li
            key={item.id}
            className={`flex flex-col gap-2 rounded-lg border bg-white/70 px-3 py-2 dark:bg-slate-950/30 sm:flex-row sm:items-center sm:justify-between ${selected?.id === item.id ? 'border-accent' : 'border-amber-200/80 dark:border-amber-900/50'}`}
          >
            <span className="w-full min-w-0 break-words text-sm sm:flex-1">{item.label}</span>
            <button
              type="button"
              className="min-h-11 min-w-11 self-start rounded-lg px-2 text-left text-sm font-medium text-accent hover:underline sm:self-auto"
              onClick={() => start(item)}
              disabled={status === 'saving' || status === 'unknown'}
              aria-pressed={selected?.id === item.id}
            >
              Change lookup
            </button>
          </li>
        ))}
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

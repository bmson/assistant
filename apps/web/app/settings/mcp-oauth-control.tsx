'use client';

import { useEffect, useEffectEvent, useRef, useState } from 'react';
import {
  type McpOAuthFlow,
  type McpOAuthStart,
  type McpOAuthStatus,
  mcpOAuthIdPattern,
} from '@/lib/mcp-oauth-wire';
import { btnSm } from '@/lib/ui';
import { ConfirmButton } from '@/lib/ui-client';

async function request<T>(path: string, method = 'GET', signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error('Tool sign-in status unavailable');
  return response.json() as Promise<T>;
}

const flowOutcomes: readonly McpOAuthFlow['outcome'][] = [
  'pending',
  'processing',
  'authorized',
  'denied',
  'cancelled',
  'expired',
  'failed',
  'superseded',
];

const checking = 'Sign-in is still being checked. Refresh its status before trying again.';
const unknown = 'Couldn’t confirm the change. Check its status before trying again.';

function outcomeNotice(outcome: McpOAuthFlow['outcome'], status: McpOAuthStatus, flowId: string) {
  switch (outcome) {
    case 'authorized':
      return status.grant === 'authorized' && status.grantGeneration === flowId
        ? 'Sign-in confirmed.'
        : unknown;
    case 'pending':
    case 'processing':
      return checking;
    case 'cancelled':
      return 'Sign-in attempt cancelled.';
    case 'denied':
      return 'The service did not grant access.';
    case 'expired':
      return 'This sign-in attempt expired.';
    case 'failed':
    case 'superseded':
      return 'This sign-in attempt didn’t complete.';
    default:
      return unknown;
  }
}

export function McpOAuthControl({
  connectionId,
  disabled,
}: {
  connectionId: string;
  disabled: boolean;
}) {
  const path = `/api/mobile/v1/mcp/${encodeURIComponent(connectionId)}/oauth`;
  const storageKey = `assistant:mcp-oauth:${connectionId}`;
  const [status, setStatus] = useState<McpOAuthStatus>();
  const [pending, setPending] = useState<string>();
  const [providerAvailable, setProviderAvailable] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [notice, setNotice] = useState('');
  const working = useRef(false);
  const controller = useRef<AbortController | null>(null);

  function remember(flowId?: string) {
    if (flowId) sessionStorage.setItem(storageKey, flowId);
    else sessionStorage.removeItem(storageKey);
    setPending(flowId);
  }

  async function readStatus(signal: AbortSignal, verify = false) {
    const next = await request<McpOAuthStatus>(
      verify ? `${path}?verify=provider` : path,
      'GET',
      signal,
    );
    if (
      next.connectionId !== connectionId ||
      typeof next.signInAvailable !== 'boolean' ||
      !['none', 'authorized', 'reauthorization_required'].includes(next.grant)
    ) {
      throw new Error('Unverified connection');
    }
    if (!signal.aborted) {
      setStatus(next);
      if (verify) setProviderAvailable(next.providerAvailable === true);
    }
    return next;
  }

  async function readFlow(signal: AbortSignal, flowId: string, method = 'GET') {
    const result = await request<McpOAuthFlow>(
      `${path}/flow?flowId=${encodeURIComponent(flowId)}`,
      method,
      signal,
    );
    if (
      result.connectionId !== connectionId ||
      result.flowId !== flowId ||
      !flowOutcomes.includes(result.outcome)
    ) {
      throw new Error('Unverified attempt');
    }
    return result.outcome;
  }

  async function reconcile(signal: AbortSignal, flowId?: string) {
    const outcome = flowId ? await readFlow(signal, flowId) : undefined;
    const next = await readStatus(signal);
    if (outcome && flowId && !signal.aborted) {
      setNotice(outcomeNotice(outcome, next, flowId));
      if (outcome !== 'pending' && outcome !== 'processing') remember();
    }
    if (!signal.aborted) setUnconfirmed(false);
  }

  const reconcileOnMount = useEffectEvent(reconcile);

  useEffect(() => {
    const lifetime = new AbortController();
    controller.current = lifetime;
    working.current = true;
    setBusy(true);
    Promise.resolve()
      .then(async () => {
        let stored: string | null = null;
        try {
          stored = sessionStorage.getItem(storageKey);
        } catch {
          // Status remains available in browsers that restrict tab storage.
        }
        const flowId = stored && mcpOAuthIdPattern.test(stored) ? stored : undefined;
        if (lifetime.signal.aborted) return;
        setPending(flowId);
        await reconcileOnMount(lifetime.signal, flowId);
      })
      .catch(() => {
        if (!lifetime.signal.aborted) setUnconfirmed(true);
      })
      .finally(() => {
        if (!lifetime.signal.aborted) {
          working.current = false;
          setBusy(false);
        }
      });
    return () => lifetime.abort();
  }, [storageKey]);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted || disabled || working.current) return;
    working.current = true;
    setBusy(true);
    setNotice('');
    try {
      await action(signal);
    } catch {
      if (!signal.aborted) {
        setNotice(unknown);
        setProviderAvailable(undefined);
        setUnconfirmed(true);
      }
    } finally {
      if (!signal.aborted) {
        working.current = false;
        setBusy(false);
      }
    }
  }

  if (!status && !pending) return null;
  if (!status?.signInAvailable && (!status || status.grant === 'none') && !pending) return null;

  return (
    <div className="mt-3 grid gap-2 border-t border-edge pt-3">
      {status?.grant === 'authorized' && (
        <p className="text-sm font-medium text-strong">Tool sign-in authorized</p>
      )}
      {status?.grant === 'reauthorization_required' && (
        <p className="text-sm font-medium text-strong">Tool sign-in needs attention</p>
      )}
      <div className="flex flex-wrap gap-2">
        {!pending && !unconfirmed && status?.signInAvailable && providerAvailable !== true && (
          <button
            type="button"
            className={btnSm.outline}
            disabled={disabled || busy}
            onClick={() =>
              void run(async (signal) => {
                const next = await readStatus(signal, true);
                if (!signal.aborted && next.providerAvailable !== true) {
                  setNotice(
                    'Browser sign-in isn’t available for this service. Manual setup is still available.',
                  );
                }
              })
            }
          >
            Check browser sign-in
          </button>
        )}
        {!pending && !unconfirmed && status?.signInAvailable && providerAvailable === true && (
          <button
            type="button"
            className={btnSm.outline}
            disabled={disabled || busy}
            onClick={() =>
              void run(async (signal) => {
                const start = await request<McpOAuthStart>(path, 'POST', signal);
                const url = new URL(start.authorizationUrl);
                if (
                  start.connectionId !== connectionId ||
                  !mcpOAuthIdPattern.test(start.flowId) ||
                  !(Date.parse(start.expiresAt) > Date.now()) ||
                  url.protocol !== 'https:' ||
                  url.username ||
                  url.password ||
                  url.hash
                )
                  throw new Error('Invalid authorization link');
                if (signal.aborted) return;
                remember(start.flowId);
                window.location.assign(url.href);
              })
            }
          >
            {status.grant === 'none' ? 'Sign in to this service' : 'Reconnect sign-in'}
          </button>
        )}
        {(pending || unconfirmed) && (
          <button
            type="button"
            className={btnSm.outline}
            disabled={disabled || busy}
            onClick={() => void run((signal) => reconcile(signal, pending))}
          >
            Check sign-in status
          </button>
        )}
        {pending && (
          <button
            type="button"
            className={btnSm.outline}
            disabled={disabled || busy || unconfirmed}
            onClick={() =>
              void run(async (signal) => {
                const outcome = await readFlow(signal, pending, 'DELETE');
                const next = await readStatus(signal);
                if (signal.aborted) return;
                setNotice(outcomeNotice(outcome, next, pending));
                if (outcome !== 'pending' && outcome !== 'processing') remember();
              })
            }
          >
            Cancel sign-in attempt
          </button>
        )}
        {status && status.grant !== 'none' && (
          <ConfirmButton
            size="sm"
            confirmLabel="Confirm disconnect"
            disabled={disabled || busy || unconfirmed || !!pending}
            onConfirm={() =>
              void run(async (signal) => {
                await request<McpOAuthStatus>(path, 'DELETE', signal);
                const next = await readStatus(signal);
                if (!signal.aborted) {
                  setUnconfirmed(next.grant !== 'none');
                  setNotice(next.grant === 'none' ? 'Tool sign-in disconnected.' : unknown);
                }
              })
            }
          >
            Disconnect sign-in
          </ConfirmButton>
        )}
      </div>
      <p className="text-sm text-muted" role="status">
        {busy ? 'Checking tool sign-in…' : notice}
      </p>
    </div>
  );
}

'use client';

import { LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { McpAuthorizationDiagnostic } from '@/lib/mcp-authorization-types';
import { btnSm } from '@/lib/ui';

/** Transient presentation only; never a connection status or saved credential. */
export type McpSignInOptionsResult = McpAuthorizationDiagnostic;

export async function checkMcpSignInOptions(id: string): Promise<McpSignInOptionsResult> {
  const response = await fetch(`/api/mobile/v1/mcp/${encodeURIComponent(id)}/authorization`, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error('Sign-in options unavailable');
  const value = await response.json();
  if (
    value.connectionId !== id ||
    value.authenticated !== false ||
    value.oauthConnectionSupported !== false ||
    value.transportProtocolVersion !== '2025-11-25' ||
    !['supported', 'unsupported', 'discovery_failed'].includes(value.status) ||
    !Array.isArray(value.authorizationServers) ||
    value.authorizationServers.length > 3 ||
    (value.status === 'supported' && value.authorizationServers.length === 0) ||
    value.authorizationServers.some(
      (server: { issuer?: unknown }) => typeof server?.issuer !== 'string',
    )
  ) {
    throw new Error('Sign-in options unverified');
  }
  return value;
}

function failedResult(): McpSignInOptionsResult {
  return {
    status: 'discovery_failed',
    authenticated: false,
    oauthConnectionSupported: false,
    transportProtocolVersion: '2025-11-25',
    resource: null,
    authorizationServers: [],
    reason: 'request_failed',
  };
}

export function McpSignInOptionsResultView({ result }: { result: McpSignInOptionsResult }) {
  const authorizationHosts = result.authorizationServers.flatMap((server) => {
    try {
      const url = new URL(server.issuer);
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
        ? [url.host]
        : [];
    } catch {
      return [];
    }
  });
  return (
    <div className="min-w-0 space-y-2 text-sm leading-6" role="status" aria-live="polite">
      <p className="font-medium text-strong">
        {result.reason === 'connection_disabled'
          ? 'Connection is paused'
          : result.status === 'supported'
            ? 'Sign-in setup found'
            : result.status === 'unsupported'
              ? 'No supported sign-in setup found'
              : 'Couldn’t check sign-in options'}
      </p>
      {result.status === 'supported'
        ? Array.from(new Set(authorizationHosts)).map((host) => (
            <p key={host} className="min-w-0 text-muted">
              Sign-in server reported by this service: <span className="break-all">{host}</span>
            </p>
          ))
        : null}
      <p className="text-muted">
        {result.reason === 'connection_disabled'
          ? 'Enable this connection before checking sign-in options. Saved authentication hasn’t changed.'
          : result.status === 'supported'
            ? 'This service reports browser sign-in options. Automatic sign-in is not available in Assistant.'
            : result.status === 'unsupported'
              ? 'Assistant couldn’t validate a supported sign-in setup for this connection. Manual setup is still available.'
              : 'Your saved connection and authentication haven’t changed. You can try checking again.'}
      </p>
    </div>
  );
}

type CheckProps = {
  connection: {
    id: string;
    endpoint: string;
    enabled: boolean;
    hasBearerToken: boolean;
    revision?: string;
  };
  disabled?: boolean;
  check?: (id: string) => Promise<McpSignInOptionsResult>;
};

export function McpSignInOptions(props: CheckProps) {
  const { id, endpoint, enabled, hasBearerToken, revision } = props.connection;
  const identity = JSON.stringify([id, endpoint, enabled, hasBearerToken, revision]);
  return <ConnectionSignInCheck key={identity} {...props} />;
}

function ConnectionSignInCheck({
  connection,
  disabled = false,
  check = checkMcpSignInOptions,
}: CheckProps) {
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const [observation, setObservation] = useState<{
    pending: boolean;
    result?: McpSignInOptionsResult;
  }>();

  useEffect(() => {
    return () => {
      sequence.current += 1;
      inFlight.current = false;
    };
  }, []);

  const current = observation;
  const run = async () => {
    if (disabled || !connection.enabled || inFlight.current) return;
    const attempt = ++sequence.current;
    inFlight.current = true;
    setObservation({ pending: true });
    try {
      const result = await check(connection.id);
      if (sequence.current === attempt) setObservation({ pending: false, result });
    } catch {
      if (sequence.current === attempt) {
        setObservation({ pending: false, result: failedResult() });
      }
    } finally {
      if (sequence.current === attempt) inFlight.current = false;
    }
  };

  return (
    <div className="mt-3 min-w-0 space-y-3 border-t border-edge pt-3">
      <p className="text-xs leading-5 text-muted">
        {connection.enabled
          ? 'Check public sign-in setup without signing in or changing saved credentials.'
          : 'Enable this connection before checking sign-in options.'}
      </p>
      <button
        type="button"
        disabled={disabled || !connection.enabled || current?.pending}
        className={`${btnSm.outline} min-h-11 max-w-full whitespace-normal text-left`}
        onClick={() => void run()}
      >
        {current?.pending ? <LoaderCircle className="size-3 motion-safe:animate-spin" /> : null}
        {current?.pending ? 'Checking sign-in options…' : 'Check sign-in options'}
      </button>
      {current?.result ? <McpSignInOptionsResultView result={current.result} /> : null}
    </div>
  );
}

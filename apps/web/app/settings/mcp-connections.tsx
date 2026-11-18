'use client';

import { Cable, ChevronDown, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import {
  createMcpConnectionAction,
  deleteMcpConnectionAction,
  refreshMcpConnectionAction,
  setMcpConnectionEnabledAction,
} from '@/app/settings/actions';
import { Badge, btn, btnSm, inputClass, labelClass } from '@/lib/ui';
import { ConfirmButton } from '@/lib/ui-client';
import { McpSignInOptions } from './mcp-sign-in-options';

type McpConnection = {
  id: string;
  name: string;
  endpoint: string;
  status: 'ready' | 'checking' | 'authorization_required' | 'error' | 'disabled';
  enabled: boolean;
  hasBearerToken: boolean;
  serverName: string | null;
  serverVersion: string | null;
  instructions: string | null;
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
  lastCheckedAt: Date | null;
  lastError: string | null;
};

const STATUS: Record<
  McpConnection['status'],
  { label: string; tone: 'green' | 'amber' | 'red' | 'neutral' }
> = {
  ready: { label: 'Ready', tone: 'green' },
  checking: { label: 'Checking', tone: 'amber' },
  authorization_required: { label: 'Authorization needed', tone: 'amber' },
  error: { label: 'Needs attention', tone: 'red' },
  disabled: { label: 'Disabled', tone: 'neutral' },
};

/**
 * This intentionally uses the same server actions as the mobile transport:
 * discovery belongs to the owner-managed connection, not to either client.
 */
export function McpConnectionsPanel({
  connections,
  discoveryAvailable = true,
  executionAvailable = true,
}: {
  connections: McpConnection[];
  discoveryAvailable?: boolean;
  executionAvailable?: boolean;
}) {
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [bearerToken, setBearerToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (key: string, action: () => Promise<{ error?: string }>, after?: () => void) => {
    setError(null);
    setPendingAction(key);
    startTransition(async () => {
      try {
        const result = await action();
        if (result.error) setError(result.error);
        else after?.();
      } catch {
        setError('Unable to update the MCP connection. Try again.');
      } finally {
        setPendingAction(null);
      }
    });
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-sm leading-6 text-muted">
          {discoveryAvailable
            ? executionAvailable
              ? 'Connect Streamable HTTP MCP servers here. The assistant can inspect their tools, but every remote call still follows your approval rules.'
              : 'Connect and inspect Streamable HTTP MCP servers here. MCP tool execution is not yet available with Firestore persistence.'
            : 'Save and manage Streamable HTTP MCP endpoints here. Tool discovery is unavailable with Firestore persistence.'}
        </p>
      </div>

      <form
        className="grid gap-3 rounded-2xl bg-sunken/55 p-4 sm:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          run(
            'create',
            () =>
              createMcpConnectionAction({ name, endpoint, bearerToken: bearerToken || undefined }),
            () => {
              setName('');
              setEndpoint('');
              setBearerToken('');
            },
          );
        }}
      >
        <label className={`${labelClass} grid min-w-0 gap-1.5`}>
          Name
          <input
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Home Assistant"
            className={inputClass}
            maxLength={80}
          />
        </label>
        <label className={`${labelClass} grid min-w-0 gap-1.5 sm:col-span-2`}>
          <span>
            Bearer token <span className="font-normal normal-case text-muted">(optional)</span>
          </span>
          <input
            type="password"
            value={bearerToken}
            onChange={(event) => setBearerToken(event.target.value)}
            placeholder="Stored encrypted; never shown again"
            className={inputClass}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={8_192}
          />
        </label>
        <label className={`${labelClass} grid min-w-0 gap-1.5 sm:col-span-2`}>
          MCP endpoint
          <input
            required
            type="url"
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            placeholder="https://example.com/mcp"
            className={inputClass}
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
        <button type="submit" disabled={pending} className={`${btn.primary} justify-center`}>
          {pendingAction === 'create' ? (
            <LoaderCircle className="size-4 motion-safe:animate-spin" />
          ) : (
            <Cable className="size-4" />
          )}
          {pendingAction === 'create' ? (discoveryAvailable ? 'Inspecting…' : 'Saving…') : 'Add'}
        </button>
      </form>

      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {connections.length === 0 ? (
        <p className="rounded-xl border border-dashed border-edge px-4 py-5 text-sm text-muted">
          No MCP connections yet.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {connections.map((connection) => {
            const status = STATUS[connection.status];
            const actionKey = (name: string) => `${name}:${connection.id}`;
            return (
              <article key={connection.id} className="rounded-2xl border border-edge bg-raised p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium text-strong">{connection.name}</h3>
                      <Badge tone={status.tone} size="xs">
                        {status.label}
                      </Badge>
                    </div>
                    <p className="mt-1 break-all font-mono text-xs leading-5 text-muted">
                      {connection.endpoint}
                    </p>
                    {connection.hasBearerToken ? (
                      <p className="mt-1 text-xs text-muted">Bearer authentication configured</p>
                    ) : null}
                    {connection.serverName ? (
                      <p className="mt-2 text-sm text-muted">
                        {connection.serverName}
                        {connection.serverVersion ? ` · ${connection.serverVersion}` : ''}
                        {` · ${connection.tools.length} ${connection.tools.length === 1 ? 'tool' : 'tools'}`}
                      </p>
                    ) : null}
                    {connection.lastError ? (
                      <p className="mt-2 text-sm text-red-600 dark:text-red-400">
                        {connection.lastError}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex min-w-0 max-w-full shrink-0 flex-wrap gap-2">
                    {discoveryAvailable ? (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          run(actionKey('refresh'), () => refreshMcpConnectionAction(connection.id))
                        }
                        className={btnSm.outline}
                      >
                        {pendingAction === actionKey('refresh') ? (
                          <LoaderCircle className="size-3 motion-safe:animate-spin" />
                        ) : (
                          <RefreshCw className="size-3" />
                        )}
                        Refresh
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        run(actionKey('enabled'), () =>
                          setMcpConnectionEnabledAction(connection.id, !connection.enabled),
                        )
                      }
                      className={btnSm.outline}
                    >
                      {pendingAction === actionKey('enabled') ? (
                        <LoaderCircle className="size-3 motion-safe:animate-spin" />
                      ) : null}
                      {connection.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <ConfirmButton
                      size="sm"
                      disabled={pending}
                      confirmLabel="Confirm remove"
                      title={`Remove ${connection.name}, its tools, and saved credential`}
                      onConfirm={() =>
                        run(actionKey('delete'), () => deleteMcpConnectionAction(connection.id))
                      }
                    >
                      <Trash2 className="size-3" />
                      {pendingAction === actionKey('delete') ? 'Removing…' : 'Remove'}
                    </ConfirmButton>
                  </div>
                </div>
                <McpSignInOptions
                  connection={{
                    ...connection,
                    revision: JSON.stringify([connection.status, connection.lastCheckedAt]),
                  }}
                  disabled={pending}
                />
                {connection.tools.length > 0 ? (
                  <details className="mt-3 border-t border-edge pt-3">
                    <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted">
                      <ChevronDown className="size-3" aria-hidden="true" />
                      Discovered tools ({connection.tools.length})
                    </summary>
                    <ul className="mt-2 grid gap-1.5 text-xs leading-5 text-muted">
                      {connection.tools.map((tool) => (
                        <li key={tool.name}>
                          <span className="font-mono text-strong">{tool.name}</span>
                          {tool.description ? ` — ${tool.description}` : ''}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

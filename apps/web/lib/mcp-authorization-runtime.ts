import type { McpAuthorizationDiagnostic } from './mcp-authorization-types';
import {
  inspectMcpAuthorizationEndpoint,
  readOwnerMcpAuthorizationConnection,
  unavailableMcpAuthorizationDiagnostic,
} from './server';

export interface McpAuthorizationConnectionRef {
  id: string;
  ownerId: string;
  endpoint: string;
  enabled: boolean;
}
export type OwnerMcpAuthorizationResult =
  | { kind: 'not_found' }
  | { kind: 'changed' }
  | { kind: 'diagnostic'; diagnostic: McpAuthorizationDiagnostic & { connectionId: string } };

/** Testable owner boundary: the inspector can receive only the stored endpoint, never ciphertext. */
export async function diagnoseStoredMcpAuthorization(
  ownerId: string,
  connectionId: string,
  ports: {
    read(ownerId: string, id: string): Promise<McpAuthorizationConnectionRef | null>;
    inspect(
      endpoint: string,
      options: { signal?: AbortSignal },
    ): Promise<McpAuthorizationDiagnostic>;
  },
  signal?: AbortSignal,
): Promise<OwnerMcpAuthorizationResult> {
  const before = await ports.read(ownerId, connectionId);
  if (!before || before.ownerId !== ownerId || before.id !== connectionId)
    return { kind: 'not_found' };
  if (!before.enabled)
    return {
      kind: 'diagnostic',
      diagnostic: { ...unavailableMcpAuthorizationDiagnostic('connection_disabled'), connectionId },
    };
  const diagnostic = await ports.inspect(before.endpoint, { signal });
  const after = await ports.read(ownerId, connectionId);
  if (
    !after ||
    after.id !== before.id ||
    after.ownerId !== before.ownerId ||
    after.endpoint !== before.endpoint ||
    after.enabled !== before.enabled
  )
    return { kind: 'changed' };
  return { kind: 'diagnostic', diagnostic: { ...diagnostic, connectionId } };
}

/** Both stores use their existing owner checks; no connection/discovery mutation is performed. */
export async function diagnoseOwnerMcpAuthorization(
  ownerId: string,
  connectionId: string,
  signal?: AbortSignal,
): Promise<OwnerMcpAuthorizationResult> {
  return diagnoseStoredMcpAuthorization(
    ownerId,
    connectionId,
    {
      read: readOwnerMcpAuthorizationConnection,
      inspect: inspectMcpAuthorizationEndpoint,
    },
    signal,
  );
}

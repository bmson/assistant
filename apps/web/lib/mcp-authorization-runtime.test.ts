import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ read: vi.fn(), inspect: vi.fn() }));
vi.mock('./server', () => ({
  readOwnerMcpAuthorizationConnection: state.read,
  inspectMcpAuthorizationEndpoint: state.inspect,
  unavailableMcpAuthorizationDiagnostic: (reason: string) => ({
    status: 'unsupported',
    authenticated: false,
    oauthConnectionSupported: false,
    transportProtocolVersion: '2025-11-25',
    resource: null,
    authorizationServers: [],
    reason,
  }),
}));

import {
  diagnoseOwnerMcpAuthorization,
  diagnoseStoredMcpAuthorization,
} from './mcp-authorization-runtime';

const id = randomUUID();
const ref = { id, ownerId: 'owner', endpoint: 'https://mcp.example/mcp', enabled: true };
const diagnostic = {
  status: 'supported' as const,
  authenticated: false as const,
  oauthConnectionSupported: false as const,
  transportProtocolVersion: '2025-11-25' as const,
  resource: ref.endpoint,
  authorizationServers: [],
  reason: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  state.read.mockResolvedValue(ref);
  state.inspect.mockResolvedValue(diagnostic);
});

describe('stored MCP authorization diagnostics owner boundary', () => {
  it.each([null, { ...ref, ownerId: 'foreign' }, { ...ref, id: randomUUID() }])(
    'does not inspect a missing/foreign/mismatched reference',
    async (row) => {
      const inspect = vi.fn();
      expect(
        await diagnoseStoredMcpAuthorization('owner', id, { read: async () => row, inspect }),
      ).toEqual({ kind: 'not_found' });
      expect(inspect).not.toHaveBeenCalled();
    },
  );
  it('does not contact a disabled connection', async () => {
    const inspect = vi.fn();
    expect(
      await diagnoseStoredMcpAuthorization('owner', id, {
        read: async () => ({ ...ref, enabled: false }),
        inspect,
      }),
    ).toMatchObject({
      kind: 'diagnostic',
      diagnostic: {
        connectionId: id,
        status: 'unsupported',
        reason: 'connection_disabled',
        authenticated: false,
      },
    });
    expect(inspect).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ...ref, endpoint: 'https://other.example/mcp' },
    { ...ref, enabled: false },
    { ...ref, ownerId: 'foreign' },
  ])('does not report stale metadata after connection drift', async (after) => {
    const read = vi.fn().mockResolvedValueOnce(ref).mockResolvedValueOnce(after);
    expect(
      await diagnoseStoredMcpAuthorization('owner', id, { read, inspect: state.inspect }),
    ).toEqual({ kind: 'changed' });
  });
  it('uses the server facade for both owner-scoped reads and forwards only the endpoint', async () => {
    state.read.mockResolvedValue({ ...ref, bearerTokenEncrypted: 'private-ciphertext' });
    const controller = new AbortController();
    const result = await diagnoseOwnerMcpAuthorization('owner', id, controller.signal);
    expect(result).toEqual({ kind: 'diagnostic', diagnostic: { ...diagnostic, connectionId: id } });
    expect(state.read).toHaveBeenCalledTimes(2);
    expect(state.read).toHaveBeenNthCalledWith(1, 'owner', id);
    expect(state.read).toHaveBeenNthCalledWith(2, 'owner', id);
    expect(state.inspect).toHaveBeenCalledWith(ref.endpoint, { signal: controller.signal });
    expect(JSON.stringify(state.inspect.mock.calls)).not.toContain('private-ciphertext');
    expect(JSON.stringify(result)).not.toContain('private-ciphertext');
  });
  it('propagates local inventory failure without contacting the endpoint', async () => {
    state.read.mockRejectedValue(new Error('unavailable'));
    await expect(diagnoseOwnerMcpAuthorization('owner', id)).rejects.toThrow('unavailable');
    expect(state.inspect).not.toHaveBeenCalled();
  });
});
